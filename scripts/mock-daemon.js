// Development-only printer agent that speaks the attempt protocol (v2).
// It never prints: each attempt walks RECEIVED -> DOWNLOADING -> SUBMITTING ->
// SUBMITTED, which is still only a submission report. Operators confirm output.
//
//   PRINTFLOW_DAEMON_ACCESS_TOKEN=<device access token> node scripts/mock-daemon.js <shopId> [--fail]
//
// --fail reports FAILED_PRE_SUBMISSION instead, to exercise the Retry flow.
const { io } = require('socket.io-client');

const SHOP_ID = process.argv[2];
const FAIL = process.argv.includes('--fail');
const ACCESS_TOKEN = process.env.PRINTFLOW_DAEMON_ACCESS_TOKEN;
const URL = `${process.env.PRINTFLOW_BACKEND_URL || 'http://localhost:3000'}/daemon`;

if (!SHOP_ID || !ACCESS_TOKEN) {
  throw new Error('Shop ID and PRINTFLOW_DAEMON_ACCESS_TOKEN are required');
}

console.log(`Starting mock daemon for shop: ${SHOP_ID}`);

const socket = io(URL, {
  query: { shopId: SHOP_ID, role: 'daemon' },
  auth: {
    token: ACCESS_TOKEN,
    agentVersion: 'mock',
    protocolVersion: 2,
    capabilities: ['attempt-reporting-v1'],
  },
});
const sequences = new Map();
const seen = new Set();

async function report(command, status, extra = {}) {
  const sequence = (sequences.get(command.attemptId) || 0) + 1;
  sequences.set(command.attemptId, sequence);
  const event = {
    attemptId: command.attemptId,
    orderId: command.orderId,
    sequence,
    status,
    occurredAt: new Date().toISOString(),
    ...extra,
  };
  const ack = await socket.timeout(10_000).emitWithAck('attempt_event', event);
  console.log(`attempt ${command.attemptId.slice(0, 8)} #${sequence} ${status}:`, ack);
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

socket.on('connect', () => {
  console.log(`Daemon connected with socket ID: ${socket.id}`);
  socket.emit('daemon_printers_update', { printers: ['Mock Printer'] });
});
socket.on('disconnect', () => console.log('Daemon disconnected'));

socket.on('print_attempts', async ({ commands = [], redelivery } = {}) => {
  console.log(`Received ${commands.length} command(s)${redelivery ? ' (redelivery)' : ''}`);
  for (const command of commands) {
    if (seen.has(command.attemptId)) continue; // duplicate delivery
    seen.add(command.attemptId);
    await report(command, 'RECEIVED');
    await delay(1000);
    await report(command, 'DOWNLOADING');
    await delay(1000);
    if (FAIL) {
      await report(command, 'FAILED_PRE_SUBMISSION', {
        failurePhase: 'DOWNLOADING',
        errorCode: 'MOCK_FAILURE',
        errorMessage: 'Simulated failure before submission.',
      });
      continue;
    }
    const authorization = await socket
      .timeout(10_000)
      .emitWithAck('attempt_authorize', { attemptId: command.attemptId });
    if (!authorization.authorized) {
      console.log(`Not authorized: ${authorization.reason}`);
      continue;
    }
    await report(command, 'SUBMITTING');
    await delay(1000);
    await report(command, 'SUBMITTED');
  }
});
