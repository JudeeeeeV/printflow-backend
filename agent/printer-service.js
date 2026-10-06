const path = require('node:path');
const { createRequire } = require('node:module');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const PRINTER_SCAN_COMMAND =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); ' +
  'ConvertTo-Json -Compress -InputObject @(' +
  "Get-CimInstance -ClassName Win32_Printer | Where-Object { -not $_.WorkOffline -and $_.PrinterStatus -ne 7 -and $_.PortName -notmatch 'PORTPROMPT:|nul:|FILE:|SHRFAX:' } | " +
  'Select-Object -ExpandProperty Name)';

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
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        PRINTER_SCAN_COMMAND,
      ],
      {
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const output = stdout.replace(/^\uFEFF/, '').trim();
    const result = output ? JSON.parse(output) : [];
    const printerNames = Array.isArray(result) ? result : [result];
    this.printers = printerNames
      .filter((name) => typeof name === 'string' && name.length <= 200)
      .sort((a, b) => a.localeCompare(b));
    return [...this.printers];
  }

  has(printerName) {
    return !printerName || this.printers.includes(printerName);
  }

  print(filePath, { printerName, monochrome, orientation, copies, paperSize }) {
    if (!this.has(printerName)) {
      throw new Error('The selected printer is no longer available');
    }
    return this.ptp.print(filePath, {
      ...(printerName ? { printer: printerName } : {}),
      ...(monochrome ? { monochrome: true } : {}),
      ...(orientation ? { orientation } : {}),
      ...(copies ? { copies } : {}),
      ...(paperSize ? { paperSize } : {}),
    });
  }
}

module.exports = { PrinterService };
