'use strict';
const { checkInterrupted, retainFailure } = require('./phase7-deploy-lifecycle');

// One dedicated direct session owns the complete ordinary/contract pipeline.
// This key is distinct from Prisma Migrate and the individual online-index keys.
const LOCK_NAMESPACE = 17707133, LOCK_OBJECT = 1;
const HEARTBEAT_MS = 2000;
const IDENTITY_SQL = `pg_backend_pid()::int AS pid,current_database() AS database,current_schema() AS schema,
  (SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid()) AS started`;
const HELD_SQL = `EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory'
  AND pid=pg_backend_pid() AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND classid=${LOCK_NAMESPACE}::oid AND objid=${LOCK_OBJECT}::oid AND objsubid=2
  AND mode='ExclusiveLock' AND granted) AS held`;

function failure(code, phase, cause) {
  const error = Object.assign(new Error(code), { code });
  error.phase7Diagnostics = { event: code, phase, ...(cause?.code ? { queryCode: String(cause.code) } : {}) };
  return error;
}
function authorityUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw failure('PHASE7_DEPLOY_DATABASE_URL_REQUIRED', 'configuration'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.pathname.length < 2
      || /-pooler(?=\.|$)/i.test(url.hostname) || url.searchParams.getAll('pgbouncer').some(value => value !== 'false')
      || url.searchParams.getAll('schema').length > 1
      || (url.searchParams.has('schema') && url.searchParams.get('schema') !== 'public') || url.hash) {
    throw failure('PHASE7_DEPLOY_DIRECT_PUBLIC_CONNECTION_REQUIRED', 'configuration');
  }
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('connect_timeout', '15');
  url.searchParams.set('pool_timeout', '15');
  // Bound only the keeper's small catalog queries; migration/index deadlines
  // are unchanged and use their own clients.
  url.searchParams.set('socket_timeout', '15');
  url.searchParams.set('application_name', 'onlinod-phase7-deploy-authority');
  return url.toString();
}
function sameIdentity(row, owner) {
  return row && row.pid === owner.pid && row.database === owner.database && row.schema === 'public' && row.started === owner.started;
}

async function withDeploymentAuthority({ signal, databaseUrl = process.env.DATABASE_URL,
  createClient = url => new (require('@prisma/client').PrismaClient)({ datasources: { db: { url } } }),
  heartbeatMs = HEARTBEAT_MS, emit = event => console.log(JSON.stringify(event)),
} = {}, work) {
  checkInterrupted(signal, 'before-deploy-authority');
  if (typeof work !== 'function' || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) throw failure('PHASE7_DEPLOY_AUTHORITY_OPTIONS_INVALID', 'configuration');
  const url = authorityUrl(databaseUrl), controller = new AbortController();
  const interrupted = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', interrupted, { once: true });
  if (signal?.aborted) interrupted();
  let db, owner, acquired = false, timer, inflight = null, closing = false, lost = null, error, result, workStarted = false;
  const failLost = (phase, cause) => {
    lost ||= failure('PHASE7_DEPLOY_AUTHORITY_LOST', phase, cause);
    controller.abort(lost);
    return lost;
  };
  const assertCurrent = async (phase = 'authority-check') => {
    if (lost) throw lost;
    checkInterrupted(controller.signal, phase);
    if (closing) throw failure('PHASE7_DEPLOY_AUTHORITY_CLOSED', phase);
    if (!inflight) {
      inflight = (async () => {
        try {
          const rows = await db.$queryRawUnsafe(`SELECT ${IDENTITY_SQL},${HELD_SQL}`);
          if (!sameIdentity(rows[0], owner) || rows[0].held !== true) throw failure('PHASE7_DEPLOY_AUTHORITY_LOST', phase);
        } catch (cause) { throw failLost(phase, cause); }
      })();
      inflight.finally(() => { inflight = null; }).catch(() => {});
    }
    await inflight;
    checkInterrupted(controller.signal, phase);
  };
  const pulse = () => {
    if (closing || lost || controller.signal.aborted) return;
    timer = setTimeout(async () => {
      try { await assertCurrent('heartbeat'); } catch (_) { /* latched and propagated to the owned work */ }
      pulse();
    }, heartbeatMs);
  };
  try {
    db = createClient(url);
    checkInterrupted(controller.signal, 'acquire-deploy-authority');
    const rows = await db.$queryRawUnsafe(`SELECT pg_try_advisory_lock(${LOCK_NAMESPACE}::int,${LOCK_OBJECT}::int) AS acquired,${IDENTITY_SQL}`);
    // Establish ownership before observing cancellation of the acquisition.
    acquired = rows[0]?.acquired === true;
    if (!acquired) throw failure('PHASE7_DEPLOY_ALREADY_RUNNING', 'acquisition');
    owner = rows[0];
    if (!Number.isInteger(owner.pid) || owner.pid < 1 || !owner.database || owner.schema !== 'public' || !owner.started) throw failure('PHASE7_DEPLOY_AUTHORITY_IDENTITY_INVALID', 'acquisition');
    await assertCurrent('acquired');
    emit({ event: 'PHASE7_DEPLOY_AUTHORITY_ACQUIRED', pid: owner.pid });
    pulse();
    workStarted = true;
    result = await work({ signal: controller.signal, assertCurrent, identity: { pid: owner.pid, database: owner.database, started: owner.started } });
    await assertCurrent('work-complete');
  } catch (cause) {
    error = lost || (!workStarted && !String(cause?.code || '').startsWith('PHASE7_')
      ? failure('PHASE7_DEPLOY_AUTHORITY_CONNECTION_FAILED', 'acquisition', cause) : cause);
  }
  finally {
    closing = true; clearTimeout(timer);
    if (inflight) { try { await inflight; } catch (cause) { error = lost || error || cause; } }
    // Work (including cancellation and process-tree drain) has settled before
    // release. A reconnected session is never allowed to unlock someone else.
    if (acquired && owner && !lost) {
      try {
        const rows = await db.$queryRawUnsafe(`SELECT ${IDENTITY_SQL},
          CASE WHEN pg_backend_pid()=$1::int AND current_database()=$2::text
            AND (SELECT backend_start::text FROM pg_stat_activity WHERE pid=pg_backend_pid())=$3::text
          THEN pg_advisory_unlock(${LOCK_NAMESPACE}::int,${LOCK_OBJECT}::int) ELSE false END AS released`, owner.pid, owner.database, owner.started);
        if (!sameIdentity(rows[0], owner) || rows[0].released !== true) throw failure('PHASE7_DEPLOY_AUTHORITY_RELEASE_FAILED', 'release');
      } catch (cause) { error = retainFailure(error, failure('PHASE7_DEPLOY_AUTHORITY_RELEASE_FAILED', 'release', cause)); }
    }
    if (db) { try { await db.$disconnect(); } catch (cause) { error = retainFailure(error, failure('PHASE7_DEPLOY_AUTHORITY_DISCONNECT_FAILED', 'disconnect', cause)); } }
    signal?.removeEventListener('abort', interrupted);
  }
  if (lost && error !== lost) error = error ? retainFailure(lost, error) : lost;
  if (error) throw error;
  checkInterrupted(controller.signal, 'authority-cleanup-complete');
  return result;
}

module.exports = { withDeploymentAuthority, authorityUrl, LOCK_NAMESPACE, LOCK_OBJECT, HEARTBEAT_MS };
