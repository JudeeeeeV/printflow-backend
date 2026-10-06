const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, file), 'utf8'), {
    module,
    exports: module.exports,
    Buffer,
    AbortSignal,
    process: { execPath: process.execPath },
    require: (name) => (name in mocks ? mocks[name] : require(name)),
  });
  return module.exports;
}
function fixture() {
  const calls = [],
    statuses = [],
    written = [],
    removed = [];
  const { PrinterService } = load('printer-service.js', {
    'pdf-to-printer': {
      print: async (file, options) => calls.push({ file, options }),
    },
  });
  const printer = new PrinterService();
  printer.printers = ['Office'];
  const { JobProcessor } = load('job-processor.js', {
    'node:fs': {
      mkdirSync() {},
      writeFileSync: (file) => written.push(file),
      existsSync: (file) => written.includes(file),
      unlinkSync: (file) => removed.push(file),
    },
    'node-fetch': async () => ({
      ok: true,
      headers: { get: () => null },
      buffer: async () => Buffer.from('%PDF-fixture'),
    }),
    './config': { AGENT_VERSION: 'fixture' },
    './logger': { info() {}, error() {}, warn() {} },
  });
  return {
    printer,
    processor: new JobProcessor(printer, (value) => statuses.push(value)),
    calls,
    statuses,
    written,
    removed,
  };
}

test('prepared pages print with copies and paper size, without an orientation override', async () => {
  for (const orientation of ['PORTRAIT', 'LANDSCAPE']) {
    for (const [paper_size, paperSize] of [
      ['A4', 'A4'],
      ['SHORT', 'letter'],
      ['LONG', 'legal'],
    ]) {
      for (const copies of [1, 2, 99]) {
        const f = fixture();
        await f.processor.processBatch({
          printerName: 'Office',
          orders: [
            {
              id: 'order',
              file_url: 'https://example.test/file.pdf',
              orientation,
              copies,
              paper_size,
              print_color_mode: 'BLACK_AND_WHITE',
            },
          ],
        });
        assert.equal(f.calls.length, 1);
        assert.deepEqual(
          { ...f.calls[0].options },
          { printer: 'Office', monochrome: true, copies, paperSize },
        );
        assert.ok(!('orientation' in f.calls[0].options));
        assert.deepEqual(
          f.statuses.map((value) => value.status),
          ['DOWNLOADING', 'SENT_TO_SPOOLER', 'COMPLETED'],
        );
        assert.deepEqual(f.removed, f.written);
      }
    }
  }
});

test('legacy or invalid copies fall back to one, without changing page orientation', async () => {
  for (const copies of [undefined, null, 0, 100, 1.5, '2']) {
    const f = fixture();
    await f.processor.processOrder(
      {
        id: 'order',
        file_url: 'https://example.test/file.pdf',
        copies,
        paper_size: 'A4',
      },
      'Office',
    );
    assert.equal(f.calls[0].options.copies, 1);
    assert.ok(!('orientation' in f.calls[0].options));
  }
});

test('printer service ignores an obsolete orientation argument from a caller', async () => {
  const f = fixture();
  await f.printer.print('ready.pdf', {
    printerName: 'Office',
    copies: 2,
    paperSize: 'A4',
    orientation: 'landscape',
  });
  assert.ok(!('orientation' in f.calls[0].options));
  assert.equal(f.calls[0].options.copies, 2);
});

test('printer failure reports failed and cleans the temporary file', async () => {
  const f = fixture();
  f.printer.ptp.print = async () => {
    throw new Error('Printer offline');
  };
  await f.processor.processOrder(
    { id: 'order', file_url: 'https://example.test/file.pdf', copies: 2 },
    'Office',
  );
  assert.equal(f.statuses.at(-1).status, 'FAILED');
  assert.deepEqual(f.removed, f.written);
});
