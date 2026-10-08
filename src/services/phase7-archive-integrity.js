'use strict';
const { COHORTS, manifest, tableContract, failure, sha } = require('./phase7-legacy-storage-service');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function counter(value) {
  if (typeof value === 'bigint') return value >= 0n ? value : null;
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return null;
}
function inspectPartition(p) {
  const t = tableContract(p.tableName);
  const rows = counter(p.rows), bytes = counter(p.bytes), epoch = counter(p.sourceEpoch);
  if (!COHORTS.includes(p.cohortId) || t.cohort !== p.cohortId || t.disposition !== 'COMPAT_DRAIN_DROP'
      || rows === null || bytes === null || epoch === null || epoch < 1n
      || !Number.isSafeInteger(p.sequence) || p.sequence < 0
      || !Number.isSafeInteger(p.verifiedSequence) || p.verifiedSequence < 0 || p.verifiedSequence > p.sequence
      || (p.sequence === 0 && (rows !== 0n || bytes !== 0n || p.digest !== '' || p.cursor !== null))
      || (p.sequence > 0 && (rows < BigInt(p.sequence) || bytes <= 0n || !hash(p.digest)
        || !hash(p.archiveRoot) || typeof p.cursor !== 'string' || typeof p.upperBound !== 'string'))
      || (p.verifiedSequence === 0 ? ![null, ''].includes(p.verifiedDigest) : !hash(p.verifiedDigest))
      || (p.state === 'VERIFIED' && (p.verifiedSequence !== p.sequence || (p.verifiedDigest || '') !== p.digest
        || !hash(p.restoreRoot) || !p.archiveVerifiedAt))
      || (p.sequence > 0 && ['EXPORTED', 'VERIFIED'].includes(p.state) && p.cursor !== p.upperBound)) {
    throw failure('PHASE7_ARCHIVE_PARTITION_INCONSISTENT', { partitionId: p.id });
  }
  return { table: t, rows, bytes };
}
function inspectChunk(p, c) {
  if (!c || c.partitionId !== p.id || counter(c.sourceEpoch) !== counter(p.sourceEpoch)
      || !Number.isSafeInteger(c.sequence) || c.sequence < 1 || c.sequence > p.sequence
      || !Number.isSafeInteger(c.rows) || c.rows < 1 || c.rows > manifest.pageRows
      || !Number.isSafeInteger(c.bytes) || c.bytes < 1 || c.bytes > manifest.pageBytes
      || typeof c.endCursor !== 'string' || !hash(c.digest)
      || (c.sequence === 1 ? c.startCursor !== null || c.previousDigest !== ''
        : typeof c.startCursor !== 'string' || !hash(c.previousDigest))
      || c.fileName !== sha(JSON.stringify([p.id, String(p.sourceEpoch), c.sequence, c.digest])) + '.jsonl') {
    throw failure('PHASE7_ARCHIVE_CHUNK_INCONSISTENT', { partitionId: p.id });
  }
}
async function verifyTotals(db, p) {
  const a = await db.phase7RetirementChunk.aggregate({ where: { partitionId: p.id, sourceEpoch: p.sourceEpoch },
    _count: { _all: true }, _sum: { rows: true, bytes: true }, _min: { sequence: true }, _max: { sequence: true } });
  if (a._count._all !== p.sequence || counter(a._sum.rows ?? 0) !== counter(p.rows)
      || counter(a._sum.bytes ?? 0) !== counter(p.bytes)
      || (p.sequence === 0 ? a._min.sequence !== null || a._max.sequence !== null
        : a._min.sequence !== 1 || a._max.sequence !== p.sequence)) {
    throw failure('PHASE7_ARCHIVE_TOTALS_MISMATCH', { partitionId: p.id });
  }
}
// One SQL statement observes a consistent receipt set. It returns only one
// invalid identity, never all tenants/chunks to the application. Used only at
// the explicit destructive-admission boundary, not in normal request traffic.
async function assertArchiveAdmission(db, archive) {
  const rows = await db.$queryRawUnsafe(`SELECT p."id" FROM "Phase7RetirementPartition" p
    LEFT JOIN LATERAL (SELECT count(*) AS n,COALESCE(sum(c."rows"),0) AS rows,COALESCE(sum(c."bytes"),0) AS bytes,
      min(c."sequence") AS first,max(c."sequence") AS last
      FROM "Phase7RetirementChunk" c WHERE c."partitionId"=p."id" AND c."sourceEpoch"=p."sourceEpoch") c ON true
    WHERE p."cohortId"=ANY($1::text[]) AND (
      p."state"<>'VERIFIED' OR p."sourceEpoch"<1 OR p."sequence"<0
      OR p."archiveVerifiedAt" IS NULL OR p."restoreRoot" IS DISTINCT FROM $3::text
      OR p."verifiedSequence"<>p."sequence" OR COALESCE(p."verifiedDigest",'')<>p."digest"
      OR c.n<>p."sequence" OR c.rows<>p."rows" OR c.bytes<>p."bytes"
      OR (p."sequence"=0 AND (p."rows"<>0 OR p."bytes"<>0 OR p."digest"<>'' OR p."cursor" IS NOT NULL))
      OR (p."sequence">0 AND (p."archiveRoot" IS DISTINCT FROM $2::text OR c.first<>1 OR c.last<>p."sequence"
        OR p."rows"<p."sequence" OR p."bytes"<=0 OR p."digest" !~ '^[a-f0-9]{64}$'
        OR p."cursor" IS NULL OR p."upperBound" IS NULL OR p."cursor" IS DISTINCT FROM p."upperBound"))
    ) ORDER BY p."id" LIMIT 1`, COHORTS, archive.exportRoot, archive.restoreRoot);
  if (rows.length) throw failure('PHASE7_ARCHIVE_ADMISSION_INCONSISTENT', { partitionId: rows[0].id });
}
module.exports = { counter, inspectPartition, inspectChunk, verifyTotals, assertArchiveAdmission };
