const nodeFs = require('node:fs');
const path = require('node:path');

/**
 * Durable, per-attempt execution journal.
 *
 * One JSON file per attempt holds its execution phase and the status events
 * the backend has not acknowledged yet. Files are written atomically (temp
 * file, fsync, rename). The journal never stores credentials, signed download
 * URLs or document contents.
 *
 * Phases:
 *   RECEIVED, DOWNLOADING      - nothing has been sent to the printer
 *   INVOKING                   - intent persisted; the print utility may run
 *   SUBMITTED                  - the print utility returned successfully
 *   FAILED_PRE_SUBMISSION      - known failure before invoking the printer
 *   OUTCOME_UNKNOWN            - invocation may have printed; never repeat it
 *   ABANDONED                  - superseded or revoked before invocation
 */
const PRE_INVOCATION = new Set(['RECEIVED', 'DOWNLOADING']);
const TERMINAL = new Set([
  'SUBMITTED',
  'FAILED_PRE_SUBMISSION',
  'OUTCOME_UNKNOWN',
  'ABANDONED',
]);
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class JournalWriteError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'JournalWriteError';
    this.cause = cause;
  }
}

class AttemptJournal {
  constructor(directory, { fs = nodeFs, now = () => Date.now() } = {}) {
    this.directory = path.join(directory, 'attempts');
    this.fs = fs;
    this.now = now;
    this.records = new Map();
  }

  /** Loads every record; corrupt files are set aside, never executed. */
  load() {
    this.fs.mkdirSync(this.directory, { recursive: true });
    const corrupt = [];
    for (const name of this.fs.readdirSync(this.directory)) {
      if (!name.endsWith('.json')) continue;
      const file = path.join(this.directory, name);
      try {
        const record = JSON.parse(this.fs.readFileSync(file, 'utf8'));
        if (!ATTEMPT_ID.test(record.attemptId)) throw new Error('invalid');
        this.records.set(record.attemptId, record);
      } catch {
        corrupt.push(name);
        try {
          this.fs.renameSync(file, `${file}.corrupt`);
        } catch {
          // Leave it in place; it is skipped on every load.
        }
      }
    }
    this.prune();
    return { count: this.records.size, corrupt };
  }

  get(attemptId) {
    return this.records.get(attemptId);
  }

  list(deviceId) {
    return [...this.records.values()].filter(
      (record) => record.deviceId === deviceId,
    );
  }

  /** Attempts this device holds but has not started printing. */
  waiting(deviceId) {
    return this.list(deviceId).filter((record) =>
      PRE_INVOCATION.has(record.phase),
    );
  }

  /** Records receipt of a command. Must succeed before it is acknowledged. */
  create(command, deviceId) {
    const timestamp = new Date(this.now()).toISOString();
    const record = {
      attemptId: command.attemptId,
      orderId: command.orderId,
      deviceId,
      revisionId: command.revisionId ?? null,
      printerName: command.printerName ?? null,
      settings: command.settings,
      expectedFile: {
        sha256: command.file?.sha256 ?? null,
        size: command.file?.size ?? null,
      },
      phase: 'RECEIVED',
      nextSequence: 1,
      pending: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    return this.transition(record, {}, { status: 'RECEIVED' });
  }

  /**
   * Applies a phase change and, optionally, a new status event in one atomic
   * write. Throws JournalWriteError if the record could not be persisted; the
   * in-memory state is unchanged in that case.
   */
  transition(recordOrId, changes = {}, event = null) {
    const current =
      typeof recordOrId === 'string' ? this.records.get(recordOrId) : recordOrId;
    if (!current) throw new JournalWriteError('Unknown attempt');
    const next = {
      ...current,
      ...changes,
      pending: [...(changes.pending ?? current.pending)],
      updatedAt: new Date(this.now()).toISOString(),
    };
    let appended = null;
    if (event) {
      appended = {
        attemptId: next.attemptId,
        orderId: next.orderId,
        sequence: next.nextSequence,
        status: event.status,
        failurePhase: event.failurePhase ?? null,
        errorCode: event.errorCode ?? null,
        errorMessage: event.errorMessage
          ? String(event.errorMessage).slice(0, 500)
          : null,
        occurredAt: next.updatedAt,
      };
      next.nextSequence += 1;
      next.pending.push(appended);
    }
    this.persist(next);
    this.records.set(next.attemptId, next);
    return { record: next, event: appended };
  }

  /** Removes an event once the backend persisted it. */
  acknowledge(attemptId, sequence) {
    const record = this.records.get(attemptId);
    if (!record || !record.pending.some((event) => event.sequence === sequence))
      return;
    this.transition(record, {
      pending: record.pending.filter((event) => event.sequence !== sequence),
    });
  }

  /** Unacknowledged events for one device, oldest first. */
  pendingEvents(deviceId) {
    return this.list(deviceId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .flatMap((record) => record.pending);
  }

  /**
   * Startup recovery: an interrupted invocation becomes uncertain and is never
   * printed again. Pre-invocation work waits for the backend to redeliver it.
   */
  recover(deviceId) {
    const recovered = [];
    for (const record of this.list(deviceId)) {
      if (record.phase !== 'INVOKING') continue;
      this.transition(
        record,
        { phase: 'OUTCOME_UNKNOWN' },
        {
          status: 'OUTCOME_UNKNOWN',
          failurePhase: 'SUBMITTING',
          errorCode: 'AGENT_RESTARTED',
          errorMessage:
            'The agent stopped while the print utility was running. Check the printer and its queue.',
        },
      );
      recovered.push(record.attemptId);
    }
    return recovered;
  }

  persist(record) {
    const file = path.join(this.directory, `${record.attemptId}.json`);
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      const descriptor = this.fs.openSync(temporary, 'w');
      try {
        this.fs.writeSync(descriptor, JSON.stringify(record));
        this.fs.fsyncSync(descriptor);
      } finally {
        this.fs.closeSync(descriptor);
      }
      this.fs.renameSync(temporary, file);
    } catch (error) {
      try {
        this.fs.unlinkSync(temporary);
      } catch {
        // Nothing to clean up.
      }
      throw new JournalWriteError(
        `The print journal could not be written: ${error.message}`,
        error,
      );
    }
  }

  /** Drops settled records after the retention period. */
  prune() {
    const cutoff = this.now() - RETENTION_MS;
    for (const record of [...this.records.values()]) {
      if (
        TERMINAL.has(record.phase) &&
        record.pending.length === 0 &&
        Date.parse(record.updatedAt) < cutoff
      ) {
        try {
          this.fs.unlinkSync(
            path.join(this.directory, `${record.attemptId}.json`),
          );
          this.records.delete(record.attemptId);
        } catch {
          // Keep it; pruning is best effort.
        }
      }
    }
  }
}

module.exports = {
  AttemptJournal,
  JournalWriteError,
  PRE_INVOCATION,
  TERMINAL,
};
