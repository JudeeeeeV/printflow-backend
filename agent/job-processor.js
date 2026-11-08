const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const nodeFetch = require('node-fetch');
const { AGENT_VERSION, PROTOCOL_VERSION } = require('./config');
const { JournalWriteError, PRE_INVOCATION } = require('./attempt-journal');

/** Must match the backend's MAX_PRINTABLE_PDF_BYTES. */
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const INVOCATION_TIMEOUT_MS = 5 * 60 * 1000;
const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A failure known to have happened before the print utility was invoked. */
class PreSubmissionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function printOptions(command) {
  const settings = command.settings || {};
  return {
    printerName: command.printerName || undefined,
    monochrome: settings.colorMode === 'BLACK_AND_WHITE',
    copies:
      Number.isInteger(settings.copies) &&
      settings.copies >= 1 &&
      settings.copies <= 99
        ? settings.copies
        : 1,
    paperSize:
      settings.paperSize === 'SHORT'
        ? 'letter'
        : settings.paperSize === 'LONG'
          ? 'legal'
          : 'A4',
  };
}

/**
 * Executes attempt-bound print commands one at a time.
 *
 * transport.sendEvent(event) resolves to { ack, retry } once the backend has
 * (or has not) persisted the event; transport.authorize(attemptId) rechecks
 * the attempt immediately before invoking the printer.
 */
class JobProcessor {
  constructor({
    printerService,
    journal,
    transport,
    deviceId,
    logger,
    fetch = nodeFetch,
    fs = nodeFs,
    tempDirectory = path.join(os.tmpdir(), 'PrintFlow'),
    invocationTimeoutMs = INVOCATION_TIMEOUT_MS,
  }) {
    this.printerService = printerService;
    this.journal = journal;
    this.transport = transport;
    this.deviceId = deviceId;
    this.logger = logger;
    this.fetch = fetch;
    this.fs = fs;
    this.tempDirectory = tempDirectory;
    this.invocationTimeoutMs = invocationTimeoutMs;
    this.queue = Promise.resolve();
    this.queued = new Set();
    this.active = new Set();
    this.flushing = null;
    this.flushAgain = false;
  }

  /** Startup: interrupted invocations become uncertain; replay the outbox. */
  start() {
    const recovered = this.journal.recover(this.deviceId);
    for (const attemptId of recovered)
      this.logger.warn(
        `Print attempt ${attemptId} was interrupted during invocation; reported as outcome unknown`,
      );
    void this.flush();
    return recovered;
  }

  enqueue(payload) {
    if (
      !payload ||
      Number(payload.protocolVersion) !== PROTOCOL_VERSION ||
      !Array.isArray(payload.commands) ||
      payload.commands.length > 100
    ) {
      this.logger.warn('Rejected an invalid print command payload');
      return this.queue;
    }
    for (const command of payload.commands) {
      if (!this.isValid(command)) {
        this.logger.warn('Ignored a malformed or foreign print command');
        continue;
      }
      if (this.queued.has(command.attemptId)) continue;
      this.queued.add(command.attemptId);
      this.queue = this.queue
        .then(() => this.process(command))
        .catch((error) =>
          this.logger.error(`Print attempt processing failed: ${error.message}`),
        )
        .finally(() => this.queued.delete(command.attemptId));
    }
    return this.queue;
  }

  /** Attempts waiting behind other work, for the heartbeat. */
  waitingAttemptIds() {
    return [
      ...new Set([
        ...this.queued,
        ...this.journal.waiting(this.deviceId).map((record) => record.attemptId),
      ]),
    ];
  }

  isValid(command) {
    return Boolean(
      command &&
        ATTEMPT_ID.test(command.attemptId) &&
        typeof command.orderId === 'string' &&
        // Never execute work assigned to another device identity.
        command.deviceId === this.deviceId &&
        command.file &&
        typeof command.file.url === 'string',
    );
  }

  async process(command) {
    const { attemptId } = command;
    if (this.active.has(attemptId)) return;
    let record = this.journal.get(attemptId);
    if (record && !PRE_INVOCATION.has(record.phase)) {
      // Re-delivery of work already invoked or settled never prints twice.
      this.logger.warn(
        `Ignored duplicate delivery of print attempt ${attemptId} (${record.phase})`,
      );
      void this.flush();
      return;
    }
    if (!record) {
      try {
        record = this.journal.create(command, this.deviceId).record;
      } catch (error) {
        // Not acknowledged; the backend keeps it queued for redelivery.
        this.logger.error(
          `Print attempt ${attemptId} was not accepted: ${error.message}`,
        );
        return;
      }
      void this.flush();
    }

    this.active.add(attemptId);
    const tempFile = path.join(this.tempDirectory, `${randomUUID()}.pdf`);
    try {
      await this.execute(record, command, tempFile);
    } finally {
      this.active.delete(attemptId);
      try {
        if (this.fs.existsSync(tempFile)) this.fs.unlinkSync(tempFile);
      } catch (error) {
        this.logger.warn(`Temporary print file cleanup failed: ${error.message}`);
      }
      void this.flush();
    }
  }

  async execute(record, command, tempFile) {
    const { attemptId } = record;
    // --- Before invocation: every failure is a known pre-submission failure.
    try {
      this.journal.transition(
        attemptId,
        { phase: 'DOWNLOADING' },
        { status: 'DOWNLOADING' },
      );
      void this.flush();
      const document = await this.download(command);
      this.fs.mkdirSync(this.tempDirectory, { recursive: true });
      this.fs.writeFileSync(tempFile, document, { flag: 'wx' });
      if (!this.printerService.has(command.printerName)) {
        throw new PreSubmissionError(
          'PRINTER_UNAVAILABLE',
          'The selected printer is no longer installed on this computer.',
        );
      }
      const authorization = await this.transport.authorize(attemptId);
      if (!authorization?.authorized) {
        const reason = authorization?.reason || 'UNAVAILABLE';
        if (['SUPERSEDED', 'ORDER_NOT_PRINTABLE', 'WRONG_DEVICE', 'ATTEMPT_NOT_FOUND', 'INVALID_STATE'].includes(reason)) {
          this.journal.transition(attemptId, { phase: 'ABANDONED' });
          this.logger.warn(
            `Print attempt ${attemptId} is no longer authorized (${reason}); it was not printed`,
          );
          return;
        }
        throw new PreSubmissionError(
          reason === 'DEVICE_PAUSED' ? 'DEVICE_PAUSED' : 'AUTHORIZATION_UNAVAILABLE',
          reason === 'DEVICE_PAUSED'
            ? 'Printing is paused until an earlier uncertain attempt on this agent is resolved.'
            : 'The backend could not confirm this attempt before printing.',
        );
      }
      // Persist invocation intent and the SUBMITTING event in one write.
      this.journal.transition(
        attemptId,
        { phase: 'INVOKING' },
        { status: 'SUBMITTING' },
      );
    } catch (error) {
      const code =
        error instanceof PreSubmissionError
          ? error.code
          : error instanceof JournalWriteError
            ? 'JOURNAL_WRITE_FAILED'
            : 'PREPARATION_FAILED';
      this.fail(attemptId, code, error.message);
      return;
    }
    void this.flush();

    // --- Invocation: from here on, an error never proves nothing printed.
    const invocation = Promise.resolve()
      .then(() => this.printerService.print(tempFile, printOptions(command)))
      .then(
        () => ({ ok: true }),
        (error) => ({ ok: false, error }),
      );
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(
        () => resolve({ timedOut: true }),
        this.invocationTimeoutMs,
      );
    });
    const outcome = await Promise.race([invocation, timeout]);
    clearTimeout(timer);

    if (outcome.ok) {
      this.settle(attemptId, 'SUBMITTED', { status: 'SUBMITTED' });
      this.logger.info(
        `Print attempt ${attemptId} was submitted; physical output still needs checking`,
      );
      return;
    }
    this.settle(attemptId, 'OUTCOME_UNKNOWN', {
      status: 'OUTCOME_UNKNOWN',
      failurePhase: 'SUBMITTING',
      errorCode: outcome.timedOut ? 'INVOCATION_TIMEOUT' : 'PRINT_UTILITY_ERROR',
      errorMessage: outcome.timedOut
        ? 'The print utility did not return in time. Check the printer and its queue.'
        : `The print utility reported an error: ${outcome.error?.message || 'unknown error'}`,
    });
    if (outcome.timedOut) {
      // A hung invocation pauses this agent until it settles.
      this.logger.warn(
        `Print attempt ${attemptId} is still running; further printing is paused`,
      );
      const late = await invocation;
      this.logger.warn(
        `Paused print attempt ${attemptId} finally ${late.ok ? 'returned' : `failed: ${late.error?.message}`}`,
      );
    }
  }

  async download(command) {
    let response;
    try {
      response = await this.fetch(command.file.url, {
        signal: AbortSignal.timeout(120_000),
        headers: { 'User-Agent': `PrintFlow-Agent/${AGENT_VERSION}` },
      });
    } catch (error) {
      throw new PreSubmissionError(
        'DOWNLOAD_FAILED',
        `The print file could not be downloaded: ${error.message}`,
      );
    }
    if (!response.ok)
      throw new PreSubmissionError(
        response.status === 400 || response.status === 403
          ? 'DOWNLOAD_EXPIRED'
          : 'DOWNLOAD_FAILED',
        `The print file could not be downloaded (${response.status}).`,
      );
    const declaredSize = Number(response.headers.get('content-length') || 0);
    if (declaredSize > MAX_DOCUMENT_BYTES)
      throw new PreSubmissionError('TOO_LARGE', 'The print file is too large.');
    const document = await response.buffer();
    if (document.length === 0 || document.length > MAX_DOCUMENT_BYTES)
      throw new PreSubmissionError(
        'TOO_LARGE',
        'The print file is empty or too large.',
      );
    const expected = command.file;
    if (Number.isInteger(expected.size) && document.length !== expected.size)
      throw new PreSubmissionError(
        'SIZE_MISMATCH',
        'The downloaded file does not match the approved printable file.',
      );
    if (
      typeof expected.sha256 === 'string' &&
      createHash('sha256').update(document).digest('hex') !== expected.sha256
    )
      throw new PreSubmissionError(
        'CHECKSUM_MISMATCH',
        'The downloaded file does not match the approved printable file.',
      );
    if (document.subarray(0, 4).toString('ascii') !== '%PDF')
      throw new PreSubmissionError(
        'NOT_PDF',
        'Only PDF print jobs are supported by the printer agent.',
      );
    return document;
  }

  fail(attemptId, errorCode, errorMessage) {
    this.logger.error(`Print attempt ${attemptId} failed before submission: ${errorMessage}`);
    this.settle(attemptId, 'FAILED_PRE_SUBMISSION', {
      status: 'FAILED_PRE_SUBMISSION',
      failurePhase: 'DOWNLOADING',
      errorCode,
      errorMessage,
    });
  }

  /** Journals a terminal outcome; falls back to a direct report if it cannot. */
  settle(attemptId, phase, event) {
    try {
      this.journal.transition(attemptId, { phase }, event);
      // Report now: a hung invocation must not delay its uncertain outcome.
      void this.flush();
    } catch (error) {
      this.logger.error(
        `Could not journal the outcome of print attempt ${attemptId}: ${error.message}`,
      );
      const record = this.journal.get(attemptId);
      if (record)
        void this.transport
          .sendEvent({
            attemptId,
            orderId: record.orderId,
            sequence: record.nextSequence,
            occurredAt: new Date().toISOString(),
            ...event,
          })
          .catch(() => undefined);
    }
  }

  /**
   * Sends unacknowledged events in order. Delivery is retried automatically;
   * execution never is.
   */
  flush() {
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    this.flushing = (async () => {
      do {
        this.flushAgain = false;
        for (const event of this.journal.pendingEvents(this.deviceId)) {
          let result;
          try {
            result = await this.transport.sendEvent(event);
          } catch {
            result = { ack: false, retry: true };
          }
          if (result?.ack || result?.retry === false) {
            if (!result.ack)
              this.logger.warn(
                `Backend rejected event ${event.sequence} of attempt ${event.attemptId}: ${result.code || 'unknown'}`,
              );
            try {
              this.journal.acknowledge(event.attemptId, event.sequence);
            } catch (error) {
              this.logger.warn(`Could not record an acknowledgement: ${error.message}`);
              return;
            }
          } else {
            return; // Try again after reconnecting.
          }
        }
      } while (this.flushAgain);
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  /** Drops pre-invocation work the backend superseded while we were offline. */
  reconcile(statuses) {
    for (const status of statuses || []) {
      const record = this.journal.get(status.attemptId);
      if (
        record &&
        record.deviceId === this.deviceId &&
        !status.open &&
        PRE_INVOCATION.has(record.phase) &&
        !this.active.has(record.attemptId)
      ) {
        try {
          this.journal.transition(record, { phase: 'ABANDONED' });
        } catch (error) {
          this.logger.warn(`Could not abandon attempt ${record.attemptId}: ${error.message}`);
        }
      }
    }
  }
}

module.exports = { JobProcessor, MAX_DOCUMENT_BYTES, printOptions };
