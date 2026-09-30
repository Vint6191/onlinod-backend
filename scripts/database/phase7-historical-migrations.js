'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { migrationChecksumReport } = require('./phase7-migration-checksum');
const history = require('./phase7-applied-history.json');

// This is not SQL equivalence or a blanket checksum exception. Each entry is
// backed by recovered, exact applied SQL plus pinned, already-applied forward
// repairs. Evidence SQL is never returned to the migration runner or executed.
async function reviewHistoricalMigration(migration, report, verifiedApplied) {
  if (history.version !== 1) throw new Error('PHASE7_HISTORY_REGISTRY_VERSION');
  const entry = history.migrations.find(item => item.migration === migration
    && item.storedChecksum === report.storedChecksum);
  if (!entry) return { accepted: false };
  if (!report.candidates.some(candidate => candidate.sha256 === entry.currentChecksum)) {
    return { accepted: false, reason: 'CANONICAL_SOURCE_CHANGED' };
  }
  const archived = await fs.readFile(path.join(__dirname, 'phase7-applied-history', entry.migration, entry.storedChecksum + '.sql'));
  if (!migrationChecksumReport(archived, entry.storedChecksum).matches) {
    return { accepted: false, reason: 'ARCHIVED_SOURCE_CHANGED' };
  }
  const missingRepairs = entry.repairs.filter(repair => {
    const applied = verifiedApplied.get(repair.migration);
    return !applied || !applied.candidates.some(candidate => candidate.sha256 === repair.checksum);
  }).map(repair => repair.migration);
  if (missingRepairs.length) {
    return { accepted: false, reason: 'FORWARD_REPAIRS_NOT_VERIFIED', missingRepairs };
  }
  return {
    accepted: true,
    migration,
    storedChecksum: report.storedChecksum,
    currentChecksum: report.currentChecksum,
    byteEquivalent: false,
    repairs: entry.repairs.map(repair => repair.migration),
  };
}

module.exports = { reviewHistoricalMigration };
