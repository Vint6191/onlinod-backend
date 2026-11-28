'use strict';

// Explicit migrated disposable native PostgreSQL and current Desktop source are
// required. No installed dist tree, mocked SQL, live provider or external send.
const { openNotificationChainFixture } = require('../test-support/notification-chain212-fixture.cjs');
const { runSourceCases } = require('../test-support/notification-chain212-source-cases.cjs');

async function runNotificationChainProof() {
  const report = { ok: false, nativePostgres: true, actualDesktopHandlerAndWorker: true,
    actualBackendJobClient: true, physicalHttpTransport: false, liveProvider: false,
    predecessorAdmission: 'stopped independent collectors except the initial-planning case, which publishes actual Financial and Campaign proofs; no readiness proof is synthesized', cases: [] };
  let h;
  const check = async (name, fn) => {
    const details = await fn(), item = { name, ok: true, ...(details || {}) };
    report.cases.push(item); console.log(JSON.stringify(item));
  };
  try {
    h = await openNotificationChainFixture();
    await runSourceCases(h, check);
    await require('../test-support/notification-chain212-completion-worker-cases.cjs').runCompletionWorkerCases(h, check);
    await require('../test-support/notification-chain212-live-cases.cjs').runLiveCases(h, check);
    await require('../test-support/notification-chain212-mutation-cases.cjs').runMutationCases(h, check);
    await require('../test-support/notification-chain212-upgrade-cases.cjs').runUpgradeCases(h, check);
    await require('../test-support/notification-chain212-consumer-cases.cjs').runConsumerCases(h, check);
    await require('../test-support/notification-chain212-initial-planning-cases.cjs').runInitialPlanningCases(h, check);
    report.ok = true;
    return report;
  } catch (error) {
    report.error = { code: error.code || null, message: error.message, stack: error.stack };
    throw Object.assign(error, { proofReport: report });
  } finally { await h?.close(); }
}
if (require.main === module) {
  runNotificationChainProof().then(report => console.log(JSON.stringify(report, null, 2)), error => {
    console.error(JSON.stringify(error.proofReport || { ok: false, error: error.message }, null, 2)); process.exitCode = 1;
  });
}
module.exports = { runNotificationChainProof };
