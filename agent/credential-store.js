const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { credentialsPath, dataDirectory } = require('./config');

const protectScript = [
  '$plain = [Console]::In.ReadToEnd()',
  '$secure = ConvertTo-SecureString $plain -AsPlainText -Force',
  'ConvertFrom-SecureString $secure',
].join('; ');

const unprotectScript = [
  '$cipher = [Console]::In.ReadToEnd()',
  '$secure = ConvertTo-SecureString $cipher',
  '$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)',
  'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }',
].join('; ');

function runPowerShell(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(stderr.trim() || 'Windows credential protection failed'),
        );
    });
    child.stdin.end(input, 'utf8');
  });
}

async function save(credentials) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  const serialized = JSON.stringify(credentials);
  if (process.platform !== 'win32') {
    if (process.env.NODE_ENV !== 'development') {
      throw new Error(
        'Secure credential storage is supported only on Windows.',
      );
    }
    fs.writeFileSync(credentialsPath, serialized, { mode: 0o600 });
    return;
  }
  const encrypted = await runPowerShell(protectScript, serialized);
  fs.writeFileSync(credentialsPath, encrypted, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function load() {
  if (!fs.existsSync(credentialsPath)) return null;
  const stored = fs.readFileSync(credentialsPath, 'utf8').trim();
  try {
    const plain =
      process.platform === 'win32'
        ? await runPowerShell(unprotectScript, stored)
        : stored;
    const credentials = JSON.parse(plain);
    if (
      typeof credentials.deviceId !== 'string' ||
      typeof credentials.deviceSecret !== 'string'
    ) {
      throw new Error('Credential file is incomplete');
    }
    return credentials;
  } catch (error) {
    throw new Error(
      `Stored printer-agent credentials could not be opened: ${error.message}`,
    );
  }
}

function clear() {
  if (fs.existsSync(credentialsPath)) fs.unlinkSync(credentialsPath);
}

module.exports = {
  save,
  load,
  clear,
  credentialsPath: path.resolve(credentialsPath),
};
