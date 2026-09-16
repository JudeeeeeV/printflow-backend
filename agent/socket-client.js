const { io } = require('socket.io-client');
const { AGENT_VERSION } = require('./config');
const { JobProcessor } = require('./job-processor');
const logger = require('./logger');

class AgentSocketClient {
  constructor(backendUrl, apiClient, credentials, printerService) {
    this.backendUrl = backendUrl;
    this.apiClient = apiClient;
    this.credentials = credentials;
    this.printerService = printerService;
    this.socket = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.lastPrinterSnapshot = '';
    this.timers = new Set();
    this.jobProcessor = new JobProcessor(printerService, (status) => {
      this.socket?.emit('job_status_update', status);
    });
  }

  async start() {
    this.stopped = false;
    await this.connectWithFreshToken();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.socket?.disconnect();
    this.socket = null;
  }

  async connectWithFreshToken() {
    if (this.stopped) return;
    try {
      const token = await this.apiClient.exchangeToken(this.credentials);
      this.createSocket(token.accessToken, token.shopId);
    } catch (error) {
      logger.warn(`Agent authentication is unavailable: ${error.message}`);
      this.scheduleReconnect();
    }
  }

  createSocket(accessToken, shopId) {
    this.clearTimers();
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    const socket = io(`${this.backendUrl}/daemon`, {
      query: { shopId, role: 'daemon' },
      auth: { token: accessToken, agentVersion: AGENT_VERSION },
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.reconnectAttempt = 0;
      logger.info('Printer agent connected to PrintFlow');
      void this.scanAndReportPrinters(true);
      this.setRepeating(
        () => socket.emit('daemon_heartbeat', { agentVersion: AGENT_VERSION }),
        25_000,
      );
      this.setRepeating(() => void this.scanAndReportPrinters(false), 45_000);
      this.setTimer(() => void this.connectWithFreshToken(), 12 * 60 * 1000);
    });

    socket.on('batch_execute', (payload) => this.jobProcessor.enqueue(payload));
    socket.on('agent_command', (command) => {
      if (command?.type === 'RESCAN_PRINTERS') {
        void this.scanAndReportPrinters(true);
      }
    });
    socket.on('disconnect', (reason) => {
      logger.warn(`Printer agent disconnected: ${reason}`);
      this.clearTimers();
      if (reason === 'io server disconnect') this.scheduleReconnect();
    });
    socket.on('connect_error', (error) => {
      logger.warn(`Printer agent connection failed: ${error.message}`);
    });
  }

  async scanAndReportPrinters(force) {
    if (!this.socket?.connected) return;
    try {
      const printers = await this.printerService.scan();
      const snapshot = JSON.stringify(printers);
      if (force || snapshot !== this.lastPrinterSnapshot) {
        this.lastPrinterSnapshot = snapshot;
        this.socket.emit('daemon_printers_update', { printers });
        logger.info(`Reported ${printers.length} installed printer(s)`);
      }
    } catch (error) {
      logger.error(`Printer discovery failed: ${error.message}`);
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(
      60_000,
      1_000 * 2 ** Math.min(this.reconnectAttempt, 6),
    );
    this.setTimer(() => void this.connectWithFreshToken(), delay);
  }

  setTimer(callback, milliseconds) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      callback();
    }, milliseconds);
    this.timers.add(timer);
    return timer;
  }

  setRepeating(callback, milliseconds) {
    const timer = setInterval(callback, milliseconds);
    this.timers.add(timer);
    return timer;
  }

  clearTimers() {
    for (const timer of this.timers) {
      clearTimeout(timer);
      clearInterval(timer);
    }
    this.timers.clear();
  }
}

module.exports = { AgentSocketClient };
