const fetch = require('node-fetch');
const { AGENT_VERSION } = require('./config');

class AgentApiClient {
  constructor(backendUrl) {
    this.backendUrl = backendUrl;
  }

  async request(
    path,
    { method = 'GET', token, body, timeoutMs = 30_000 } = {},
  ) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.backendUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': `PrintFlow-Agent/${AGENT_VERSION}`,
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') || '';
      const result = contentType.includes('application/json')
        ? await response.json()
        : { message: await response.text() };
      if (!response.ok) {
        const error = new Error(
          result.message || `Request failed (${response.status})`,
        );
        error.status = response.status;
        throw error;
      }
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  bootstrap(email, password, deviceName) {
    return this.request('/daemon-devices/bootstrap', {
      method: 'POST',
      body: { email, password, deviceName, agentVersion: AGENT_VERSION },
    });
  }

  exchangeToken(credentials) {
    return this.request('/daemon-devices/token', {
      method: 'POST',
      body: {
        deviceId: credentials.deviceId,
        deviceSecret: credentials.deviceSecret,
      },
    });
  }
}

module.exports = { AgentApiClient };
