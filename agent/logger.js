const fs = require('node:fs');
const path = require('node:path');
const { dataDirectory, logPath } = require('./config');

const MAX_LOG_BYTES = 2 * 1024 * 1024;

function rotateIfNeeded() {
  try {
    if (fs.statSync(logPath).size < MAX_LOG_BYTES) return;
    const previous = `${logPath}.1`;
    if (fs.existsSync(previous)) fs.unlinkSync(previous);
    fs.renameSync(logPath, previous);
  } catch {
    // A missing or locked log file should not stop printing.
  }
}

function write(level, message) {
  fs.mkdirSync(dataDirectory, { recursive: true });
  rotateIfNeeded();
  const safeMessage = String(message)
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, 'Bearer [REDACTED]')
    .replace(/(deviceSecret|accessToken|password)=[^\s&]+/gi, '$1=[REDACTED]');
  const line = `${new Date().toISOString()} ${level} ${safeMessage}\n`;
  try {
    fs.appendFileSync(logPath, line, 'utf8');
  } catch {
    // Avoid crashing if logging is temporarily unavailable.
  }
  if (process.env.PRINTFLOW_AGENT_CONSOLE === 'true') {
    const method =
      level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
    console[method](safeMessage);
  }
}

module.exports = {
  info: (message) => write('INFO', message),
  warn: (message) => write('WARN', message),
  error: (message) => write('ERROR', message),
};
