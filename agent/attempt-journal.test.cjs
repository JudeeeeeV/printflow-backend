const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { AttemptJournal } = require('./attempt-journal');
const { DEVICE, command, deliver, harness, pdf } = require('./agent-test-helpers.cjs');

const until = async (condition, timeoutMs = 2000) => {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const readJournalFiles = (directory) => {
  const folder = path.join(directory, 'attempts');
  return fs
    .readdirSync(folder)
    .map((name) => fs.readFileSync(path.join(folder, name), 'utf8'))
    .join('\n');
};

test('duplicate commands and lost acknowledgements never invoke the same attempt twice', async () => {
  const h = harness();
  h.transport.ack = false;
  const job = command();
  await deliver(h, job);
  await deliver(h, job);
  await deliver(h, job, job);
  assert.equal(h.calls.length, 1);
  assert.equal(h.journal.get(job.attemptId).pending.length, 4);

  h.transport.ack = true;
  await h.processor.flush();
  assert.equal(h.journal.get(job.attemptId).pending.length, 0);
  const sequences = new Set(
    h.sent.filter((event) => event.attemptId === job.attemptId).map((event) => event.sequence),
  );
  assert.deepEqual([...sequences].sort(), [1, 2, 3, 4], 'replays reuse the same sequences');
});

test('a crash before download resumes when the backend redelivers, printing once', async () => {
  const h = harness();
  const job = command();
  h.journal.create(job, DEVICE);
  const restarted = h.reopen();
  restarted.processor.start();
  await deliver(restarted, job);
  assert.equal(restarted.calls.length, 1);
  assert.equal(restarted.journal.get(job.attemptId).phase, 'SUBMITTED');
});

test('a crash during invocation becomes uncertain and is never printed again', async () => {
  const h = harness();
  const job = command();
  h.journal.create(job, DEVICE);
  h.journal.transition(job.attemptId, { phase: 'INVOKING' }, { status: 'SUBMITTING' });
  const restarted = h.reopen();
  assert.deepEqual(restarted.processor.start(), [job.attemptId]);
  await restarted.processor.flush();
  const last = restarted.sent.at(-1);
  assert.equal(last.status, 'OUTCOME_UNKNOWN');
  assert.equal(last.errorCode, 'AGENT_RESTARTED');
  await deliver(restarted, job);
  assert.equal(restarted.calls.length, 0);
});

test('a crash after the utility returned replays SUBMITTED without printing again', async () => {
  const h = harness();
  h.transport.ack = false;
  const job = command();
  await deliver(h, job);
  assert.equal(h.calls.length, 1);
  const restarted = h.reopen();
  restarted.processor.start();
  await restarted.processor.flush();
  assert.deepEqual(restarted.statuses(job.attemptId), [
    'RECEIVED',
    'DOWNLOADING',
    'SUBMITTING',
    'SUBMITTED',
  ]);
  await deliver(restarted, job);
  assert.equal(restarted.calls.length, 0);
  assert.equal(restarted.journal.get(job.attemptId).pending.length, 0);
});

test('the journal never stores signed URLs, credentials, or document contents', async () => {
  const h = harness();
  h.transport.ack = false;
  await deliver(h, command());
  const stored = readJournalFiles(h.directory);
  assert.ok(!stored.includes('secret-token'));
  assert.ok(!stored.includes('storage.test'));
  assert.ok(!stored.includes('%PDF'));
});

test('an invalid checksum or size fails before submission without printing', async () => {
  for (const [overrides, code] of [
    [{ file: { url: 'https://x.test/a', sha256: 'f'.repeat(64), size: pdf().length } }, 'CHECKSUM_MISMATCH'],
    [{ file: { url: 'https://x.test/a', sha256: null, size: 3 } }, 'SIZE_MISMATCH'],
  ]) {
    const h = harness();
    const job = command(overrides);
    await deliver(h, job);
    assert.equal(h.calls.length, 0);
    const last = h.sent.at(-1);
    assert.equal(last.status, 'FAILED_PRE_SUBMISSION');
    assert.equal(last.errorCode, code);
    assert.equal(h.transport.authorizeCalls, 0);
  }
});

test('an expired file URL fails before submission', async () => {
  const h = harness({
    fetch: async () => ({ ok: false, status: 400, headers: { get: () => null } }),
  });
  await deliver(h, command());
  assert.equal(h.calls.length, 0);
  assert.equal(h.sent.at(-1).errorCode, 'DOWNLOAD_EXPIRED');
});

test('a removed printer fails safely before invocation', async () => {
  const h = harness();
  h.printer.printers = [];
  await deliver(h, command());
  assert.equal(h.calls.length, 0);
  assert.equal(h.sent.at(-1).errorCode, 'PRINTER_UNAVAILABLE');
});

test('journal write failures stop before the printer is invoked', async () => {
  // Receipt cannot be recorded: the command is not acknowledged at all.
  const failing = {
    ...fs,
    openSync: () => {
      throw new Error('disk full');
    },
  };
  const h = harness({ journalOptions: { fs: failing } });
  const job = command();
  await deliver(h, job);
  assert.equal(h.calls.length, 0);
  assert.equal(h.sent.length, 0);
  assert.equal(h.journal.get(job.attemptId), undefined);

  // Invocation intent cannot be recorded: no print, a known failure.
  const intentFails = {
    ...fs,
    writeSync: (descriptor, data) => {
      if (String(data).includes('"phase":"INVOKING"')) throw new Error('disk full');
      return fs.writeSync(descriptor, data);
    },
  };
  const second = harness({ journalOptions: { fs: intentFails } });
  const other = command();
  await deliver(second, other);
  assert.equal(second.calls.length, 0);
  assert.equal(second.journal.get(other.attemptId).phase, 'FAILED_PRE_SUBMISSION');
  assert.equal(second.sent.at(-1).errorCode, 'JOURNAL_WRITE_FAILED');
});

test('a revoked or superseded attempt is not printed after reconnecting', async () => {
  const h = harness();
  h.transport.authorization = { authorized: false, reason: 'SUPERSEDED' };
  const job = command();
  await deliver(h, job);
  assert.equal(h.calls.length, 0);
  assert.equal(h.journal.get(job.attemptId).phase, 'ABANDONED');
  assert.ok(!h.statuses(job.attemptId).includes('SUBMITTING'));

  const paused = harness();
  paused.transport.authorization = { authorized: false, reason: 'DEVICE_PAUSED' };
  await deliver(paused, command());
  assert.equal(paused.calls.length, 0);
  assert.equal(paused.sent.at(-1).errorCode, 'DEVICE_PAUSED');

  const offline = harness();
  offline.transport.authorization = { authorized: false, reason: 'UNAVAILABLE' };
  await deliver(offline, command());
  assert.equal(offline.calls.length, 0);
  assert.equal(offline.sent.at(-1).errorCode, 'AUTHORIZATION_UNAVAILABLE');
});

test('reconciliation drops pre-invocation work the backend superseded', async () => {
  const h = harness();
  const job = command();
  h.journal.create(job, DEVICE);
  h.processor.reconcile([{ attemptId: job.attemptId, open: false }]);
  assert.equal(h.journal.get(job.attemptId).phase, 'ABANDONED');
  await deliver(h, job);
  assert.equal(h.calls.length, 0);
});

test("re-registration never executes or reports another device identity's work", async () => {
  const h = harness();
  h.transport.ack = false;
  const job = command();
  await deliver(h, job);
  const interrupted = command();
  h.journal.create(interrupted, DEVICE);
  h.journal.transition(interrupted.attemptId, { phase: 'INVOKING' });

  const otherDevice = randomUUID();
  const reregistered = h.reopen({ deviceId: otherDevice });
  assert.deepEqual(reregistered.processor.start(), []);
  await reregistered.processor.flush();
  assert.equal(reregistered.sent.length, 0);
  assert.equal(reregistered.journal.get(interrupted.attemptId).phase, 'INVOKING');
  await deliver(reregistered, job);
  assert.equal(reregistered.calls.length, 0, 'commands for another device are ignored');
});

test('a hung invocation reports an uncertain outcome and pauses further printing', async () => {
  let release;
  let invocations = 0;
  const h = harness({
    invocationTimeoutMs: 20,
    print: () => {
      invocations += 1;
      return invocations === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve();
    },
  });
  const first = command();
  const second = command();
  const done = deliver(h, first, second);
  await until(() => h.statuses(first.attemptId).includes('OUTCOME_UNKNOWN'));
  assert.equal(h.sent.find((event) => event.status === 'OUTCOME_UNKNOWN').errorCode, 'INVOCATION_TIMEOUT');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(invocations, 1, 'the next attempt waits for the hung one to settle');
  assert.ok(h.processor.waitingAttemptIds().includes(second.attemptId));
  release();
  await done;
  assert.equal(invocations, 2);
  assert.ok(!h.statuses(first.attemptId).includes('SUBMITTED'), 'a late return never upgrades an uncertain outcome');
});

test('malformed payloads and other protocol versions are ignored', async () => {
  const h = harness();
  await h.processor.enqueue({ protocolVersion: 1, commands: [command()] });
  await h.processor.enqueue({ orders: [{ id: 'legacy', file_url: 'x' }] });
  await deliver(h, { ...command(), attemptId: 'not-a-uuid' });
  assert.equal(h.calls.length, 0);
  assert.equal(h.sent.length, 0);
});

test('corrupt journal records are set aside, never executed', () => {
  const h = harness();
  const folder = path.join(h.directory, 'attempts');
  fs.writeFileSync(path.join(folder, 'broken.json'), '{not json');
  const journal = new AttemptJournal(h.directory);
  assert.deepEqual(journal.load().corrupt, ['broken.json']);
  assert.ok(fs.existsSync(path.join(folder, 'broken.json.corrupt')));
});

test('the journal lives in application data, apart from credentials and the install directory', () => {
  const config = require('./config');
  assert.ok(config.journalDirectory.startsWith(config.dataDirectory + path.sep));
  assert.ok(!config.credentialsPath.startsWith(config.journalDirectory));
  assert.ok(!config.journalDirectory.startsWith(path.dirname(process.execPath)));
  const installer = fs.readFileSync(path.join(__dirname, 'windows', 'installer-install.ps1'), 'utf8');
  // Upgrades replace only the installation directory, never application data.
  assert.ok(!/Remove-Item[^\n]*APPDATA[^\n]*PrintFlow Agent'/i.test(installer));
  assert.ok(!/agentData/i.test(installer));
  assert.deepEqual(config.AGENT_CAPABILITIES, ['attempt-reporting-v1']);
  assert.equal(config.PROTOCOL_VERSION, 2);
});
