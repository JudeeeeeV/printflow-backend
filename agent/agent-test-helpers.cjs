// Shared fixtures for the agent's Node tests (not bundled into the agent).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createHash, randomUUID } = require('node:crypto');
const { AttemptJournal } = require('./attempt-journal');
const { JobProcessor } = require('./job-processor');

const DEVICE = '00000000-0000-4000-8000-000000000001';
const quiet = { info() {}, warn() {}, error() {} };

function loadPrinterService(print) {
  const module = { exports: {} };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, 'printer-service.js'), 'utf8'),
    {
      module,
      exports: module.exports,
      process: { execPath: process.execPath },
      require: (name) =>
        name === 'pdf-to-printer' ? { print } : require(name),
    },
  );
  return module.exports.PrinterService;
}

function pdf(content = 'fixture') {
  return Buffer.from(`%PDF-1.7 ${content}`);
}

function command(overrides = {}) {
  const document = overrides.document || pdf();
  const { document: _ignored, ...rest } = overrides;
  return {
    attemptId: randomUUID(),
    orderId: randomUUID(),
    revisionId: 'source.pdf',
    deviceId: DEVICE,
    printerName: 'Office',
    settings: {
      colorMode: 'BLACK_AND_WHITE',
      paperSize: 'A4',
      orientation: 'PORTRAIT',
      copies: 1,
    },
    file: {
      url: 'https://storage.test/signed?token=secret-token',
      sha256: createHash('sha256').update(document).digest('hex'),
      size: document.length,
    },
    ...rest,
  };
}

/**
 * A processor with a real on-disk journal. `transport.ack` controls whether
 * the backend acknowledges events; `transport.authorization` the pre-print
 * recheck.
 */
function harness(options = {}) {
  const directory =
    options.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'pf-agent-'));
  const calls = [];
  const sent = [];
  const PrinterService = loadPrinterService(
    options.print ||
      (async (file, printOptions) => {
        calls.push({ file, options: printOptions });
      }),
  );
  const printer = new PrinterService();
  printer.printers = ['Office'];
  const journal = options.journal || new AttemptJournal(directory, options.journalOptions);
  if (!options.journal) journal.load();
  const transport = {
    ack: true,
    authorization: { authorized: true },
    authorizeCalls: 0,
    async sendEvent(event) {
      sent.push(event);
      return this.ack ? { ack: true, result: 'APPLIED' } : { ack: false, retry: true };
    },
    async authorize() {
      this.authorizeCalls += 1;
      return this.authorization;
    },
  };
  const documents = new Map();
  const fetch =
    options.fetch ||
    (async () => {
      const document = options.document || pdf();
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(document.length) },
        buffer: async () => document,
      };
    });
  const processor = new JobProcessor({
    printerService: printer,
    journal,
    transport,
    deviceId: options.deviceId || DEVICE,
    logger: quiet,
    fetch,
    tempDirectory: path.join(directory, 'tmp'),
    invocationTimeoutMs: options.invocationTimeoutMs,
  });
  return {
    directory,
    journal,
    processor,
    printer,
    transport,
    calls,
    sent,
    documents,
    statuses: (attemptId) =>
      sent.filter((event) => event.attemptId === attemptId).map((event) => event.status),
    reopen: (overrides = {}) => {
      const reopened = new AttemptJournal(directory);
      reopened.load();
      return harness({ ...options, ...overrides, directory, journal: reopened });
    },
  };
}

const deliver = (h, ...commands) =>
  h.processor.enqueue({ protocolVersion: 2, commands });

module.exports = { DEVICE, command, deliver, harness, loadPrinterService, pdf, quiet };
