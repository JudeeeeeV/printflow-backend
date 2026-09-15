const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const fetch = require('node-fetch');

const envPath = path.join(__dirname, '../.env');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) return;
    const key = line
      .slice(0, eqIdx)
      .trim()
      .replace(/^\uFEFF/, '');
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  });
}

const BACKEND_URL =
  process.env.PRINTFLOW_BACKEND_URL || 'http://localhost:3000';
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log('=========================================');
console.log('   PrintFlow Physical Daemon Login');
console.log('=========================================\n');

rl.question('Shop Email: ', (email) => {
  rl.question('Password: ', async (password) => {
    rl.close();
    try {
      const response = await fetch(`${BACKEND_URL}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
        }),
      });
      const result = await response.json();
      if (
        !response.ok ||
        !result.token ||
        result.user?.roleTag !== 'Print Shop'
      ) {
        throw new Error(result.message || 'A print-shop account is required');
      }

      const daemonPath = path.join(__dirname, 'physical-daemon.js');
      const daemonProcess = spawn('node', [daemonPath, result.user.id], {
        stdio: 'inherit',
        env: {
          ...process.env,
          PRINTFLOW_BACKEND_URL: BACKEND_URL,
          PRINTFLOW_DAEMON_ACCESS_TOKEN: result.token,
        },
      });
      daemonProcess.on('close', (code) => process.exit(code || 0));
    } catch (error) {
      console.error('Login failed:', error.message);
      process.exit(1);
    }
  });
});
