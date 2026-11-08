const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const { command, deliver, harness, loadPrinterService } = require('./agent-test-helpers.cjs');

test('prepared pages print with copies and paper size, without an orientation override', async () => {
  for (const orientation of ['PORTRAIT', 'LANDSCAPE']) {
    for (const [paperSize, expectedPaper] of [
      ['A4', 'A4'],
      ['SHORT', 'letter'],
      ['LONG', 'legal'],
    ]) {
      for (const copies of [1, 2, 99]) {
        const h = harness();
        const job = command({
          settings: { colorMode: 'BLACK_AND_WHITE', paperSize, orientation, copies },
        });
        await deliver(h, job);
        assert.equal(h.calls.length, 1);
        assert.deepEqual(
          { ...h.calls[0].options },
          { printer: 'Office', monochrome: true, copies, paperSize: expectedPaper },
        );
        assert.ok(!('orientation' in h.calls[0].options));
        assert.deepEqual(h.statuses(job.attemptId), [
          'RECEIVED',
          'DOWNLOADING',
          'SUBMITTING',
          'SUBMITTED',
        ]);
        assert.equal(fs.existsSync(h.calls[0].file), false, 'temporary file removed');
      }
    }
  }
});

test('legacy or invalid copies fall back to one, without changing page orientation', async () => {
  for (const copies of [undefined, null, 0, 100, 1.5, '2']) {
    const h = harness();
    await deliver(
      h,
      command({ settings: { colorMode: 'COLOR', paperSize: 'A4', copies } }),
    );
    assert.equal(h.calls[0].options.copies, 1);
    assert.ok(!('monochrome' in h.calls[0].options));
    assert.ok(!('orientation' in h.calls[0].options));
  }
});

test('printer service ignores an obsolete orientation argument from a caller', async () => {
  const calls = [];
  const PrinterService = loadPrinterService(async (file, options) =>
    calls.push({ file, options }),
  );
  const printer = new PrinterService();
  printer.printers = ['Office'];
  await printer.print('ready.pdf', {
    printerName: 'Office',
    copies: 2,
    paperSize: 'A4',
    orientation: 'landscape',
  });
  assert.ok(!('orientation' in calls[0].options));
  assert.equal(calls[0].options.copies, 2);
});

test('a print-utility error after invocation is uncertain, never a plain failure', async () => {
  let file;
  const h = harness({
    print: async (path) => {
      file = path;
      throw new Error('Printer offline');
    },
  });
  const job = command();
  await deliver(h, job);
  const last = h.sent.at(-1);
  assert.equal(last.status, 'OUTCOME_UNKNOWN');
  assert.equal(last.errorCode, 'PRINT_UTILITY_ERROR');
  assert.equal(h.journal.get(job.attemptId).phase, 'OUTCOME_UNKNOWN');
  assert.equal(fs.existsSync(file), false);
});
