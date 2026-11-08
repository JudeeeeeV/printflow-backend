const { io } = require('socket.io-client');
const {
  AGENT_VERSION,
  AGENT_CAPABILITIES,
  PROTOCOL_VERSION,
} = require('./config');
const { JobProcessor } = require('./job-processor');
const logger = require('./logger');

const ACK_TIMEOUT_MS = 15_000;

class AgentSocketClient {
  constructor(
    backendUrl,
    apiClient,
    credentials,
    printerService,
    onCredentialsRejected,
    journal,
  ) {
    this.backendUrl = backendUrl;
    this.apiClient = apiClient;
    this.credentials = credentials;
    this.printerService = printerService;
    this.onCredentialsRejected = onCredentialsRejected;
    this.socket = null;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.lastPrinterSnapshot = '';
    this.timers = new Set();
    // Bound to this registration's device; another identity's journal
    // records are never executed or reported.
    this.jobProcessor = new JobProcessor({
      printerService,
      journal,
      deviceId: credentials.deviceId,
      logger,
      transport: {
        sendEvent: (event) => this.request('attempt_event', event, { ack: false, retry: true }),
        authorize: (attemptId) =>
          this.request('attempt_authorize', { attemptId }, { authorized: false, reason: 'UNAVAILABLE' }),
      },
    });
    this.jobProcessor.start();
  }

  /** Emits with an acknowledgement, or returns the fallback when offline. */
  async request(name, payload, fallback) {
    const socket = this.socket;
    if (!socket?.connected) return fallback;
    try {
      return await socket.timeout(ACK_TIMEOUT_MS).emitWithAck(name, payload);
    } catch {
      return fallback;
    }
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
      if (error.status === 401) {
        logger.warn(
          'Printer-agent registration is no longer valid; registration is required again',
        );
        this.stop();
        await this.onCredentialsRejected?.();
        return;
      }
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
      auth: {
        token: accessToken,
        agentVersion: AGENT_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: AGENT_CAPABILITIES,
      },
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
      void this.reconcile();
      this.setRepeating(
        () =>
          socket.emit('daemon_heartbeat', {
            agentVersion: AGENT_VERSION,
            waitingAttemptIds: this.jobProcessor.waitingAttemptIds(),
          }),
        25_000,
      );
      this.setRepeating(() => void this.scanAndReportPrinters(false), 3_000);
      // Retry unacknowledged status reports (delivery only, never execution).
      this.setRepeating(() => void this.jobProcessor.flush(), 30_000);
      this.setTimer(() => void this.connectWithFreshToken(), 12 * 60 * 1000);
    });

    socket.on('print_attempts', (payload) => {
      void this.jobProcessor.enqueue(payload);
    });
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

  /** Replays the outbox and drops work the backend superseded meanwhile. */
  async reconcile() {
    await this.jobProcessor.flush();
    const attemptIds = this.jobProcessor.waitingAttemptIds();
    if (attemptIds.length === 0) return;
    const result = await this.request(
      'attempt_reconcile',
      { attemptIds },
      { attempts: [] },
    );
    this.jobProcessor.reconcile(result?.attempts);
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
