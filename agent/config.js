const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const AGENT_VERSION = '0.1.0';
const appDataRoot =
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dataDirectory = path.join(appDataRoot, 'PrintFlow Agent');
const configPath = path.join(dataDirectory, 'agent-config.json');

function readLocalConfig() {
  try {
    return JSON.parse(
      fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''),
    );
  } catch {
    return {};
  }
}

function backendUrl() {
  const localConfig = readLocalConfig();
  const value =
    process.env.PRINTFLOW_BACKEND_URL ||
    localConfig.backendUrl ||
    'http://localhost:3000';
  const parsed = new URL(String(value).replace(/\/+$/, ''));
  const isLocal =
    parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
  if (parsed.protocol !== 'https:' && !isLocal) {
    throw new Error('The printer agent requires HTTPS for non-local backends.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

module.exports = {
  AGENT_VERSION,
  dataDirectory,
  configPath,
  credentialsPath: path.join(dataDirectory, 'credentials.dat'),
  logPath: path.join(dataDirectory, 'agent.log'),
  backendUrl,
};
