const path = require('node:path');
const { createRequire } = require('node:module');

function loadPrinterLibrary() {
  try {
    return require('pdf-to-printer');
  } catch (originalError) {
    try {
      const externalRequire = createRequire(
        path.join(path.dirname(process.execPath), 'agent-loader.cjs'),
      );
      return externalRequire('pdf-to-printer');
    } catch {
      throw originalError;
    }
  }
}

class PrinterService {
  constructor() {
    this.ptp = loadPrinterLibrary();
    this.printers = [];
  }

  async scan() {
    const result = await this.ptp.getPrinters();
    this.printers = result
      .map((printer) => printer.name)
      .filter((name) => typeof name === 'string' && name.length <= 200)
      .sort((a, b) => a.localeCompare(b));
    return [...this.printers];
  }

  has(printerName) {
    return !printerName || this.printers.includes(printerName);
  }

  print(filePath, { printerName, monochrome }) {
    if (!this.has(printerName)) {
      throw new Error('The selected printer is no longer available');
    }
    return this.ptp.print(filePath, {
      ...(printerName ? { printer: printerName } : {}),
      ...(monochrome ? { monochrome: true } : {}),
    });
  }
}

module.exports = { PrinterService };
