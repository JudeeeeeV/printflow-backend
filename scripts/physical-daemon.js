// Retired: this development daemon printed with order-only callbacks and a
// user token, without a registered device identity. The backend now requires
// attempt-bound reporting from a registered device, so it would only be shown
// as "Agent update required" and its reports would be ignored.
//
// Use one of these instead:
//   npm run agent                         real printing through the PrintFlow Agent
//                                         (set NODE_ENV=development off Windows)
//   node scripts/mock-daemon.js <shopId>  simulated attempts, no printing
console.error(
  'scripts/physical-daemon.js is retired. Run "npm run agent" to print with a registered PrintFlow Agent, or "node scripts/mock-daemon.js <shopId>" to simulate attempts.',
);
process.exitCode = 1;
