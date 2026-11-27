'use strict';

// Requires an explicitly selected, migrated disposable local PostgreSQL fixture
// and the sibling Desktop source tree. Never reads the application DATABASE_URL.
const { openSubscriberChainFixture } = require('../test-support/subscriber-chain211-fixture.cjs');
const { runSourceCases } = require('../test-support/subscriber-chain211-source-cases.cjs');
const { runMutationCases } = require('../test-support/subscriber-chain211-mutation-cases.cjs');

async function runSubscriberChainProof() {
  const report = { ok: false, nativePostgres: true, actualDesktopHandlerAndWorker: true,
    actualBackendJobClient: true, physicalHttpTransport: false, liveProvider: false,
    predecessorAdmission: 'explicit stopped independent collectors; no financial/campaign readiness proof is synthesized', cases: [] };
  let h;
  const check = async (name, fn) => {
    const details = await fn(); const item = { name, ok: true, ...(details || {}) };
    report.cases.push(item); console.log(JSON.stringify(item));
  };
  try {
    h = await openSubscriberChainFixture();
    await runSourceCases(h, check);
    report.cases.push(...await runMutationCases(h));
    const { runSubscriberReadCases } = require('../test-support/subscriber-read211-cases.cjs');
    await runSubscriberReadCases(h, check);
    report.ok = true;
    return report;
  } catch (error) {
    report.error = { code: error.code || null, message: error.message, stack: error.stack };
    throw Object.assign(error, { proofReport: report });
  } finally { await h?.close(); }
}

if (require.main === module) {
  runSubscriberChainProof().then(report => console.log(JSON.stringify(report, null, 2)), error => {
    console.error(JSON.stringify(error.proofReport || { ok: false, error: error.message }, null, 2)); process.exitCode = 1;
  });
}
module.exports = { runSubscriberChainProof };
