const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sea = require('node:sea');

function writeAsset(name, targetPath) {
  const asset = sea.getRawAsset(name);
  fs.writeFileSync(targetPath, Buffer.from(asset));
}

function showError(message) {
  const safeMessage = String(message).replaceAll("'", "''").slice(0, 1200);
  spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${safeMessage}', 'PrintFlow Printer Agent', 'OK', 'Error') | Out-Null`,
    ],
    { windowsHide: true, stdio: 'ignore' },
  );
}

function main() {
  if (process.platform !== 'win32' || !sea.isSea()) {
    throw new Error(
      'This setup program must run as a packaged Windows executable.',
    );
  }
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'PrintFlowAgentSetup-'),
  );
  try {
    const archivePath = path.join(tempRoot, 'agent-package.zip');
    const scriptPath = path.join(tempRoot, 'installer-install.ps1');
    writeAsset('agent-package.zip', archivePath);
    writeAsset('installer-install.ps1', scriptPath);
    const result = spawnSync(
      'powershell.exe',
      [
        '-NoLogo',
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        scriptPath,
      ],
      { cwd: tempRoot, windowsHide: true, encoding: 'utf8' },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        result.stderr?.trim() || 'The installer could not complete.',
      );
    }
  } finally {
    const resolvedTemp = path.resolve(tempRoot);
    const allowedTemp = path.resolve(os.tmpdir()) + path.sep;
    if (resolvedTemp.startsWith(allowedTemp)) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
}

try {
  main();
} catch (error) {
  showError(error instanceof Error ? error.message : 'Installation failed.');
  process.exitCode = 1;
}
