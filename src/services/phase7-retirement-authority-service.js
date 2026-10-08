'use strict';
const { COHORTS, failure, transactionRequired } = require('./phase7-legacy-storage-service');

function isRetirementBusy(error) {
  return error?.code === 'PHASE7_RETIREMENT_BUSY' || error?.code === '55P03' || error?.meta?.code === '55P03'
    || String(error?.meta?.database_error || error?.message || '').includes('PHASE7_RETIREMENT_BUSY');
}
function retirementError(error) {
  return isRetirementBusy(error) && error.code !== 'PHASE7_RETIREMENT_BUSY'
    ? failure('PHASE7_RETIREMENT_BUSY', { retryable: true, cause: error }) : error;
}

// Source relation locks precede archive metadata whenever a transaction also
// reads frozen source tables. NOWAIT handles the immutable contract's opposite
// entry point (ACCESS EXCLUSIVE source locks) without a metadata/DDL wait cycle.
async function lockRetirementSources(tx) {
  transactionRequired(tx);
  try { await tx.$executeRawUnsafe('SELECT phase7_lock_retirement_sources()'); }
  catch (error) { throw retirementError(error); }
}
async function lockRetirementCohort(tx, id) {
  transactionRequired(tx);
  if (!COHORTS.includes(id)) throw failure('PHASE7_COHORT_INVALID');
  try {
    const rows = await tx.$queryRawUnsafe('SELECT * FROM phase7_lock_retirement_cohort($1::text)', id);
    return rows[0];
  } catch (error) { throw retirementError(error); }
}
async function lockRetirementPartition(tx, id, { allowClosed = false } = {}) {
  transactionRequired(tx);
  // This is discovery only. No partition row is locked before its cohort.
  const hint = await tx.phase7RetirementPartition.findUnique({ where: { id }, select: { cohortId: true } });
  if (!hint) return null;
  const cohort = await lockRetirementCohort(tx, hint.cohortId);
  if (!allowClosed && ['PURGE_READY', 'PURGED'].includes(cohort.state)) throw failure('PHASE7_COHORT_CLOSED');
  const rows = await tx.$queryRawUnsafe('SELECT * FROM "Phase7RetirementPartition" WHERE "id"=$1 FOR UPDATE', id);
  if (rows[0] && rows[0].cohortId !== cohort.id) throw failure('PHASE7_PARTITION_COHORT_CHANGED');
  return rows[0] || null;
}
module.exports = { lockRetirementSources, lockRetirementCohort, lockRetirementPartition, isRetirementBusy, retirementError };
