"use strict";
// Dedicated single connection: the session advisory owner and online DDL use
// the same PostgreSQL session, without holding an old transaction snapshot.
const INDEXES = [
  ['TelegramDeliveryIntent_expired_commit_idx','TelegramDeliveryIntent','"agencyId","commitStartedAt","id"', '"state"=\'COMMITTING\''],
  ['AutomationDelivery_fair_claim_idx','AutomationDelivery','"agencyId","creatorId","claimedAt" DESC', '"originKind"=\'AUTOMATION\' AND "claimedAt" IS NOT NULL'],
  ['AutomationDelivery_fair_finish_idx','AutomationDelivery','"agencyId","creatorId","finishedAt" DESC', '"originKind"=\'AUTOMATION\' AND "status"=\'COMPLETED\' AND "finishedAt" IS NOT NULL'],
  ['AutomationDelivery_pending_creator_idx','AutomationDelivery','"agencyId","creatorId","priority" DESC,"notBefore","createdAt","id"', '"originKind"=\'AUTOMATION\' AND "status" IN (\'QUEUED\',\'RETRY_SCHEDULED\',\'RECONCILE_REQUIRED\')'],
  ['AutomationDelivery_expired_lease_idx','AutomationDelivery','"agencyId","claimUntil","id"', '"status" IN (\'CLAIMED\',\'RUNNING\',\'COMMITTING\',\'RECONCILE_REQUIRED\') AND "claimUntil" IS NOT NULL'],
  ['AutomationDelivery_stranded_idx','AutomationDelivery','"agencyId","writeCommitAt","id"', '"status"=\'RECONCILE_REQUIRED\' AND "claimUntil" IS NULL'],
  ['CreatorAccount_live_catalog_idx','CreatorAccount','"agencyId","id"', '"deletedAt" IS NULL'],
  ['TelegramDeliveryIntent_pending_billing_idx','TelegramDeliveryIntent','"agencyId","creatorId","createdAt","id"', '"state" IN (\'PLANNED\',\'CLAIMED\',\'FAILED_PRECOMMIT\')'],
];
const createSql = ([name,table,columns,predicate], online = true) => `CREATE INDEX ${online ? 'CONCURRENTLY ' : ''}IF NOT EXISTS "${name}" ON "${table}"(${columns})${predicate ? ` WHERE ${predicate}` : ""}`;
async function indexState(db, name) {
  return (await db.$queryRawUnsafe(`SELECT i.indisvalid AS valid,i.indisready AS ready,
    pg_get_indexdef(i.indexrelid) AS definition,pg_backend_pid()::int AS pid,
    t.relname AS "tableName",am.amname AS method,i.indisunique AS "isUnique",
    i.indnkeyatts::int AS "keyCount",i.indnatts::int AS "columnCount",
    ARRAY(SELECT pg_get_indexdef(i.indexrelid,k,false) || CASE WHEN (i.indoption[k-1] & 1)=1 THEN ' DESC' ELSE '' END FROM generate_series(1,i.indnkeyatts) k) AS columns,
    ARRAY(SELECT i.indoption[k-1]::int FROM generate_series(1,i.indnkeyatts) k) AS options,
    pg_get_expr(i.indpred,i.indrelid) AS predicate
    FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am am ON am.oid=c.relam
    WHERE n.nspname=current_schema() AND c.relname=$1`, name))[0];
}
function normalizedPredicate(value) {
  return value.toLowerCase().replace(/\s+in\s*\(([^)]*)\)/g, '=any(array[$1])')
    .replace(/::(?:text|character varying)/g, '').replace(/["\s()]/g, '');
}
function assertIndexDefinition(state, [name, table, columns, predicate]) {
  const keys = columns.split(',').map(v => v.toLowerCase().replace(/["\s]/g,''));
  if (state.tableName !== table || state.method !== 'btree' || state.isUnique
    || JSON.stringify(state.options) !== JSON.stringify(columns.split(',').map(v => / DESC$/.test(v) ? 3 : 0))
    || state.keyCount !== keys.length || state.columnCount !== keys.length
    || JSON.stringify(state.columns.map(v => v.toLowerCase().replace(/["\s]/g,''))) !== JSON.stringify(keys)
    || normalizedPredicate(state.predicate || '') !== normalizedPredicate(predicate || "")) {
    throw new Error(`PHASE4_INDEX_DEFINITION_MISMATCH:${name}`);
  }
}
async function ensureIndexes(db, { indexes = INDEXES, lockKey = 2026092415 } = {}) {
  const owner = (await db.$queryRawUnsafe('SELECT pg_try_advisory_lock(132987241,$1::int) AS acquired,pg_backend_pid()::int AS pid', lockKey))[0];
  if (!owner?.acquired) throw new Error('PHASE4_INDEX_DEPLOY_ALREADY_RUNNING');
  try {
    for (const spec of indexes) {
      const [name,table,columns,predicate] = spec;
      const exists = (await db.$queryRawUnsafe("SELECT to_regclass(format('%I.%I',current_schema(),$1))::text AS relation",table))[0]?.relation;
      if (!exists) continue; // Fresh database: the additive migration builds it.
      let state = await indexState(db,name);
      if (state && state.pid !== owner.pid) throw new Error('PHASE4_INDEX_SESSION_CHANGED');
      if (state) assertIndexDefinition(state, spec);
      if (state && (!state.valid || !state.ready)) {
        await db.$executeRawUnsafe(`DROP INDEX CONCURRENTLY "${name}"`);
        state = null;
      }
      if (!state) { await db.$executeRawUnsafe(createSql(spec)); state = await indexState(db,name); }
      if (!state?.valid || !state?.ready || state.pid !== owner.pid) throw new Error(`PHASE4_INDEX_NOT_READY:${name}`);
      assertIndexDefinition(state,spec);
    }
  } finally {
    const released = (await db.$queryRawUnsafe('SELECT pg_advisory_unlock(132987241,$1::int) AS released,pg_backend_pid()::int AS pid', lockKey))[0];
    if (!released?.released || released.pid !== owner.pid) throw new Error('PHASE4_INDEX_SESSION_OWNERSHIP_LOST');
  }
}
async function main() {
  const { PrismaClient } = require('@prisma/client');
  const url = new URL(process.env.DATABASE_URL);
  url.searchParams.set('connection_limit','1');
  const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
  try { await ensureIndexes(db); console.log('# PHASE4_EXECUTION_INDEXES_PASS'); }
  finally { await db.$disconnect(); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode=1; });
module.exports={INDEXES,createSql,ensureIndexes,assertIndexDefinition,normalizedPredicate};
