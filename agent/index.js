const credentialStore = require('./credential-store');
const { AgentApiClient } = require('./api-client');
const { runSetup } = require('./setup-server');
const { PrinterService } = require('./printer-service');
const { AgentSocketClient } = require('./socket-client');
const { backendUrl, AGENT_VERSION } = require('./config');
const logger = require('./logger');

let client;

async function main() {
  if (process.platform !== 'win32' && process.env.NODE_ENV !== 'development') {
    throw new Error(
      'The PrintFlow Printer Agent currently supports Windows only.',
    );
  }
  if (process.argv.includes('--self-test')) {
    const printerService = new PrinterService();
    await printerService.scan();
    return;
  }
  const url = backendUrl();
  const apiClient = new AgentApiClient(url);
  let credentials = await credentialStore.load();
  if (!credentials) {
    logger.info('No printer-agent registration found; opening one-time setup');
    await runSetup(apiClient, url);
    credentials = await credentialStore.load();
  }
  if (!credentials)
    throw new Error('Printer-agent registration did not complete');
  const printerService = new PrinterService();
  client = new AgentSocketClient(url, apiClient, credentials, printerService);
  await client.start();
  logger.info(`PrintFlow Printer Agent ${AGENT_VERSION} started`);
}

process.on('SIGINT', () => {
  client?.stop();
  process.exit(0);
});
process.on('SIGTERM', () => {
  client?.stop();
  process.exit(0);
});
process.on('uncaughtException', (error) => {
  logger.error(`Unexpected agent error: ${error.message}`);
});
process.on('unhandledRejection', (error) => {
  logger.error(
    `Unhandled agent rejection: ${error instanceof Error ? error.message : error}`,
  );
});

main().catch((error) => {
  logger.error(`Printer agent could not start: ${error.message}`);
  process.exitCode = 1;
});
