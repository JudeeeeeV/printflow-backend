const credentialStore = require('./credential-store');
const { AgentApiClient } = require('./api-client');
const { runSetup } = require('./setup-server');
const { PrinterService } = require('./printer-service');
const { AgentSocketClient } = require('./socket-client');
const { backendUrl, AGENT_VERSION } = require('./config');
const logger = require('./logger');

let client;
let registrationRecovery;

async function loadCredentialsOrReset() {
  try {
    return await credentialStore.load();
  } catch (error) {
    logger.warn(`${error.message}; clearing the local registration`);
    credentialStore.clear();
    return null;
  }
}

async function connectRegisteredAgent(url, apiClient, printerService) {
  let credentials = await loadCredentialsOrReset();
  if (!credentials) {
    logger.info('No valid printer-agent registration found; opening setup');
    await runSetup(apiClient, url);
    credentials = await loadCredentialsOrReset();
  }
  if (!credentials) {
    throw new Error('Printer-agent registration did not complete');
  }

  const nextClient = new AgentSocketClient(
    url,
    apiClient,
    credentials,
    printerService,
    () => recoverRegistration(url, apiClient, printerService, nextClient),
  );
  client = nextClient;
  await nextClient.start();
}

async function recoverRegistration(url, apiClient, printerService, source) {
  if (source !== client) return;
  if (registrationRecovery) return registrationRecovery;

  registrationRecovery = (async () => {
    source.stop();
    credentialStore.clear();
    logger.info('Removed invalid local credentials; opening setup again');
    await connectRegisteredAgent(url, apiClient, printerService);
    logger.info(`PrintFlow Printer Agent ${AGENT_VERSION} re-registered`);
  })();

  try {
    await registrationRecovery;
  } catch (error) {
    logger.error(`Printer-agent re-registration failed: ${error.message}`);
  } finally {
    registrationRecovery = null;
  }
}

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
  const printerService = new PrinterService();
  await connectRegisteredAgent(url, apiClient, printerService);
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
