"use strict";
const crypto = require("node:crypto");
const { runDbTransaction } = require("./db-transaction-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { assertExecutionAccessFence } = require("./execution-access-fence-service");
const { canUsePermission } = require("./team-access-control");
const { lockAgencyPipelineLifecycle, lockCreatorPipelineLifecycle } = require("./custom-content-pipeline-authority-service");
const { PROTOCOL, PAGE_SIZE, MAX_ITEMS, OBSERVATION_TTL_MS, RETIREMENT_ACCEPT_MS, CREATE_ACTIONS, CANCEL_ACTIONS, CURRENT_PREDICATE, error } = require("./mass-delivery-contract");
const root = input => input.db || require("../prisma");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const options = { timeout: 15000, maxWait: 5000, deadlineMs: 40000, maxAttempts: 3 };
const iso = value => value ? new Date(value).toISOString() : null;

function identity(input) {
  const actor = {};
  for (const name of ["agencyId", "creatorId", "userId", "memberId", "deviceId"]) {
    const value = input[name];
    if (typeof value !== "string" || !value.trim() || value.length > 180) throw error("MASS_QUEUE_SNAPSHOT_INVALID", "A complete actor, device and creator identity is required", 400);
    actor[name] = value.trim();
  }
  if (!Number.isSafeInteger(input.accessEpoch) || input.accessEpoch < 0) throw error("MASS_QUEUE_SNAPSHOT_INVALID", "A current access epoch is required", 400);
  actor.accessEpoch = input.accessEpoch;
  actor.purpose = input.purpose || "BROWSE";
  if (!["BROWSE", "RETIREMENT"].includes(actor.purpose)) throw error("MASS_QUEUE_SNAPSHOT_PURPOSE_INVALID", "Invalid snapshot purpose", 400);
  return actor;
}
async function lockScope(db, actor, { authorize = true } = {}) {
  await lockAgencyPipelineLifecycle({ db, agencyId: actor.agencyId });
  await lockCreatorPipelineLifecycle({ db, agencyId: actor.agencyId, creatorId: actor.creatorId });
  if (!authorize) return;
  const fenced = await assertExecutionAccessFence({ db, ...actor, lock: true });
  if (!(await canUsePermission({ db, member: fenced.member, key: actor.purpose === "RETIREMENT" ? "creators.manage" : "chats.mass_message" }))) {
    throw error("PROGRAMMATIC_WRITE_FORBIDDEN", "Current snapshot-purpose permission is required", 403);
  }
  if (!await db.workerDevice.findFirst({ where: { id: actor.deviceId, agencyId: actor.agencyId, userId: actor.userId }, select: { id: true } })) {
    throw error("PROGRAMMATIC_WRITE_DEVICE_INVALID", "Device is not registered for this actor", 403);
  }
}
async function ensureState(db, actor) {
  await db.$executeRawUnsafe(`INSERT INTO "MassCreatorDeliveryState"("creatorId","agencyId") VALUES ($1,$2) ON CONFLICT ("creatorId") DO NOTHING`, actor.creatorId, actor.agencyId);
  const [state] = await db.$queryRawUnsafe(`SELECT * FROM "MassCreatorDeliveryState" WHERE "creatorId"=$1 AND "agencyId"=$2 FOR UPDATE`, actor.creatorId, actor.agencyId);
  if (!state) throw error("MASS_DELIVERY_SCOPE_MISMATCH", "MASS state belongs to another agency", 403);
  return state;
}
async function session(db, actor, token) {
  if (typeof token !== "string" || token.length > 180 || !token) throw error("MASS_QUEUE_SNAPSHOT_FENCE_REQUIRED", "A durable snapshot identity is required", 400);
  const [row] = await db.$queryRawUnsafe(`SELECT * FROM "MassQueueObservation" WHERE "id"=$1 FOR UPDATE`, token);
  if (!row) throw error("MASS_QUEUE_SNAPSHOT_FENCE_EXPIRED", "Snapshot is no longer retained; refresh the queue");
  for (const key of ["agencyId", "creatorId", "userId", "memberId", "deviceId", "purpose", "accessEpoch"]) {
    if (row[key] !== actor[key]) throw error("MASS_QUEUE_SNAPSHOT_FENCE_MISMATCH", "Snapshot belongs to another actor, device, access epoch or purpose", 403);
  }
  return row;
}
function current(state, observation, now) {
  if (observation.status === "EXPIRED" || new Date(observation.retainUntil) <= now) throw error("MASS_QUEUE_SNAPSHOT_FENCE_EXPIRED", "Snapshot retention expired; read the provider queue again");
  if (BigInt(state.sourceRevision) !== BigInt(observation.sourceRevision)
      || BigInt(state.activeSequence) > BigInt(observation.sequence)
      || (observation.purpose === "RETIREMENT" && state.retirementId !== observation.retirementId)) {
    throw error("MASS_QUEUE_SNAPSHOT_SUPERSEDED", "MASS state changed during observation; read the complete provider queue again");
  }
  if (observation.status !== "APPLYING" && new Date(observation.expiresAt) <= now) throw error("MASS_QUEUE_SNAPSHOT_FENCE_EXPIRED", "Provider observation expired before acceptance");
}
function fenceResponse(row) {
  return { ok: true, protocol: PROTOCOL, purpose: row.purpose, snapshotFenceToken: row.id, retirementId: row.retirementId || null, retirementCreated: row.retirementId === row.id,
    fenceAt: iso(row.fenceAt), expiresAt: iso(row.expiresAt), pageSize: PAGE_SIZE };
}

async function beginMassRemoteQueueSnapshot(input) {
  if (input.protocol !== PROTOCOL) throw error("MASS_QUEUE_SNAPSHOT_CLIENT_UPGRADE_REQUIRED", "Update Desktop before reconciling MASS queues");
  const actor = identity(input);
  if (typeof input.snapshotRequestId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.snapshotRequestId)) throw error("MASS_QUEUE_SNAPSHOT_REQUEST_ID_REQUIRED", "A stable snapshot request identity is required", 400);
  return runDbTransaction(root(input), async db => {
    await lockScope(db, actor);
    let state = await ensureState(db, actor);
    const [prior] = await db.$queryRawUnsafe('SELECT "id" FROM "MassQueueObservation" WHERE "id"=$1', input.snapshotRequestId);
    if (prior) return fenceResponse(await session(db, actor, input.snapshotRequestId));
    const now = await dbAuthorityNow({ db });
    const creator = await db.creatorAccount.findUnique({ where: { id: actor.creatorId }, select: { remoteId: true } });
    if (actor.purpose === "RETIREMENT" && !state.retirementId) {
      await db.$executeRawUnsafe(`UPDATE "MassCreatorDeliveryState" SET "retirementId"=$2,"retirementStartedAt"=$3,"sourceRevision"="sourceRevision"+1,
        "retirementProofId"=NULL,"retirementProofRevision"=NULL,"retirementProofObservedAt"=NULL,"updatedAt"=$3 WHERE "creatorId"=$1`, actor.creatorId, input.snapshotRequestId, now);
    }
    [state] = await db.$queryRawUnsafe(`UPDATE "MassCreatorDeliveryState" SET "observationSequence"="observationSequence"+1,"updatedAt"=$2 WHERE "creatorId"=$1 RETURNING *`, actor.creatorId, now);
    const id = input.snapshotRequestId;
    const [row] = await db.$queryRawUnsafe(`INSERT INTO "MassQueueObservation"("id","agencyId","creatorId","userId","memberId","deviceId","accessEpoch","purpose","sequence","sourceRevision","retirementId","providerId","fenceAt","expiresAt","retainUntil")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      id, actor.agencyId, actor.creatorId, actor.userId, actor.memberId, actor.deviceId, actor.accessEpoch, actor.purpose,
      state.observationSequence, state.sourceRevision, actor.purpose === "RETIREMENT" ? state.retirementId : null, creator.remoteId || null,
      now, new Date(now.getTime() + OBSERVATION_TTL_MS), new Date(now.getTime() + 7 * 86400000));
    return fenceResponse(row);
  }, options);
}

async function appendMassRemoteQueueSnapshot(input) {
  const actor = identity(input);
  const ids = input.queueIds;
  if (!Number.isSafeInteger(input.page) || input.page < 0 || input.page > Math.ceil(MAX_ITEMS / PAGE_SIZE)
      || !Number.isSafeInteger(input.snapshotItemCount) || input.snapshotItemCount < 0 || input.snapshotItemCount > MAX_ITEMS
      || !Array.isArray(ids) || ids.length > PAGE_SIZE || typeof input.final !== "boolean"
      || ids.some((id, i) => typeof id !== "string" || !id.trim() || id !== id.trim() || id.length > 180 || /[^\x20-\x7E]/.test(id) || (i > 0 && ids[i - 1] >= id))) {
    throw error("MASS_QUEUE_SNAPSHOT_PAGE_INVALID", "Upload bounded pages of unique sorted exact queue identities", 400);
  }
  if (!input.final && ids.length === 0) throw error("MASS_QUEUE_SNAPSHOT_PAGE_INVALID", "An unfinished page must advance", 400);
  const digest = hash([input.page, input.snapshotItemCount, input.final, ids]);
  return runDbTransaction(root(input), async db => {
    await lockScope(db, actor);
    const state = await ensureState(db, actor);
    const row = await session(db, actor, input.snapshotFenceToken);
    const [prior] = await db.$queryRawUnsafe(`SELECT "digest" FROM "MassQueueObservationPage" WHERE "observationId"=$1 AND "ordinal"=$2`, row.id, input.page);
    if (prior) {
      if (prior.digest !== digest) throw error("MASS_QUEUE_SNAPSHOT_REPLAY_CONFLICT", "The same snapshot page was submitted with different contents");
      return { ok: true, duplicate: true, ready: row.status !== "OPEN", receivedCount: row.receivedCount };
    }
    const now = await dbAuthorityNow({ db });
    current(state, row, now);
    if (row.status !== "OPEN" || row.pageCount !== input.page || (row.itemCount !== null && row.itemCount !== input.snapshotItemCount)
        || (row.lastQueueId && ids.length && row.lastQueueId >= ids[0])) throw error("MASS_QUEUE_SNAPSHOT_PAGE_CONFLICT", "Snapshot pages must form one ordered complete set");
    const count = row.receivedCount + ids.length;
    if (count > input.snapshotItemCount || (input.final && count !== input.snapshotItemCount)) throw error("MASS_QUEUE_SNAPSHOT_IDENTITY_INCOMPLETE", "Snapshot count does not match the complete exact identity set");
    if (input.final && actor.purpose === "RETIREMENT" && input.snapshotItemCount === 0 && now.getTime() - new Date(row.fenceAt).getTime() > RETIREMENT_ACCEPT_MS) {
      throw error("MASS_QUEUE_SNAPSHOT_OBSERVATION_STALE", "The empty provider observation is too old; read again while retirement remains paused");
    }
    if (ids.length) await db.$executeRawUnsafe(`INSERT INTO "MassQueueObservationItem"("observationId","queueId") SELECT $1,value FROM jsonb_array_elements_text($2::jsonb) AS x(value)`, row.id, JSON.stringify(ids));
    await db.$executeRawUnsafe(`INSERT INTO "MassQueueObservationPage"("observationId","ordinal","digest") VALUES ($1,$2,$3)`, row.id, input.page, digest);
    await db.$executeRawUnsafe(`UPDATE "MassQueueObservation" SET "itemCount"=$2,"receivedCount"=$3,"pageCount"="pageCount"+1,"lastQueueId"=$4,
      "status"=$5,"acceptedAt"=$6 WHERE "id"=$1`, row.id, input.snapshotItemCount, count, ids.at(-1) || row.lastQueueId,
      input.final ? "READY" : "OPEN", input.final ? now : null);
    return { ok: true, duplicate: false, ready: input.final, receivedCount: count };
  }, options);
}

async function applyPresent(db, row) {
  const items = await db.$queryRawUnsafe(`SELECT "queueId" FROM "MassQueueObservationItem" WHERE "observationId"=$1 AND "queueId">$2 COLLATE "C" ORDER BY "queueId" LIMIT $3`, row.id, row.cursor || "", PAGE_SIZE);
  if (!items.length) return { phase: "CURRENT", cursor: null, pending: 0, settled: 0, cancelSettled: 0 };
  // One observation identity per remote queue. A reappearance reopens this row;
  // immutable settled application history is neither scanned nor rewritten.
  const data = items.map(({ queueId }) => ({ id: `mass-observed:${hash([row.agencyId, row.creatorId, queueId])}`, queueId,
    key: `mass-provider-observed:${row.agencyId}:${row.creatorId}:${queueId}` }));
  await db.$executeRawUnsafe(`INSERT INTO "AutomationDelivery"("id","agencyId","creatorId","moduleKey","actionType","targetId","idempotencyKey","payload","status","notBefore","maxAttempts","createdByUserId","originKind","sourceDeviceId","executionKind","reconciliationKind","intentAcknowledgedAt","remoteLifecycleState","remoteTargetId","remoteLifecycleObservedAt","result","finishedAt","updatedAt")
    SELECT x.id,$1,$2,'mass','MASS_PROVIDER_QUEUE_OBSERVED',x."queueId",x.key,'{}'::jsonb,'COMPLETED',$3,1,$4,'PROVIDER_OBSERVATION',$5,'NONE','MASS_QUEUE',$3,'PENDING',x."queueId",$3,
      jsonb_build_object('outcomeState','PROVIDER_OBSERVED','snapshotId',$6),$3,$3
    FROM jsonb_to_recordset($7::jsonb) AS x(id text,"queueId" text,key text)
    ON CONFLICT ("idempotencyKey") DO UPDATE SET "remoteLifecycleState"='PENDING',"remoteLifecycleObservedAt"=$3,"remoteSettledAt"=NULL,"updatedAt"=$3`,
    row.agencyId, row.creatorId, row.fenceAt, row.userId, row.deviceId, row.id, JSON.stringify(data));
  return { phase: "PRESENT", cursor: items.at(-1).queueId, pending: items.length, settled: 0, cancelSettled: 0 };
}
async function applyCurrent(db, row) {
  const debt = await db.$queryRawUnsafe(`SELECT d."id",d."actionType",d."status",d."writeCommitAt",d."failureCode",d."remoteLifecycleState",d."remoteTargetId",d."targetId",
      EXISTS(SELECT 1 FROM "MassQueueObservationItem" i WHERE i."observationId"=$4 AND i."queueId"=COALESCE(d."remoteTargetId",d."targetId")) AS present
    FROM "AutomationDelivery" d WHERE ${CURRENT_PREDICATE} AND d."agencyId"=$1 AND d."creatorId"=$2 AND d."id">$3 ORDER BY d."id" LIMIT $5 FOR UPDATE OF d`,
    row.agencyId, row.creatorId, row.cursor || "", row.id, PAGE_SIZE);
  if (!debt.length) return { phase: "FINAL", cursor: null, pending: 0, settled: 0, cancelSettled: 0 };
  const settled = [], cancelled = [];
  for (const d of debt) {
    if (CANCEL_ACTIONS.includes(d.actionType)) {
      if (d.writeCommitAt && d.targetId && !d.present && (["COMMITTING", "RECONCILE_REQUIRED"].includes(d.status) || (d.status === "FAILED" && d.failureCode === "outcome_unresolved_do_not_retry"))) cancelled.push(d.id);
    } else if (CREATE_ACTIONS.includes(d.actionType)) {
      // Empty current queue may settle future remote debt, never the logical
      // UNKNOWN outcome or authorize re-sending the old operation. Precommit and
      // still-in-flight writes stay blockers even during an empty observation.
      const terminal = ["COMPLETED", "FAILED", "SKIPPED", "CANCELED"].includes(d.status);
      if (terminal && ((d.remoteTargetId && !d.present) || (!d.remoteTargetId && row.itemCount === 0))) settled.push(d.id);
    }
  }
  if (settled.length) await db.$executeRawUnsafe(`UPDATE "AutomationDelivery" SET "remoteLifecycleState"='SETTLED',"remoteLifecycleObservedAt"=$2,"remoteSettledAt"=$2,"updatedAt"=$3 WHERE "id" IN (SELECT jsonb_array_elements_text($1::jsonb))`, JSON.stringify(settled), row.fenceAt, row.acceptedAt);
  if (cancelled.length) await db.$executeRawUnsafe(`UPDATE "AutomationDelivery" SET "status"='COMPLETED',"failureCode"=NULL,"failureCategory"=NULL,"lastError"=NULL,"remoteTargetId"="targetId","result"=COALESCE("result",'{}'::jsonb)||jsonb_build_object('queueId',"targetId",'outcomeState','PROVEN_SUCCESS','snapshotProof',true),"remoteLifecycleState"='SETTLED',"remoteLifecycleObservedAt"=$2,"remoteSettledAt"=$2,"finishedAt"=$3,"claimUntil"=NULL,"leaseTokenHash"=NULL,"updatedAt"=$3 WHERE "id" IN (SELECT jsonb_array_elements_text($1::jsonb))`, JSON.stringify(cancelled), row.fenceAt, row.acceptedAt);
  return { phase: "CURRENT", cursor: debt.at(-1).id, pending: 0, settled: settled.length, cancelSettled: cancelled.length };
}

async function reconcileMassRemoteQueueSnapshot(input) {
  const actor = identity(input);
  if (input.queueIds !== undefined || input.snapshotItemCount !== undefined) throw error("MASS_QUEUE_SNAPSHOT_CLIENT_UPGRADE_REQUIRED", "Upload snapshot pages before applying their durable identity");
  return runDbTransaction(root(input), async db => {
    await lockScope(db, actor);
    const state = await ensureState(db, actor);
    const row = await session(db, actor, input.snapshotFenceToken);
    if (row.status === "APPLIED") return { ...row.response, duplicate: true };
    const now = await dbAuthorityNow({ db });
    current(state, row, now);
    if (!["READY", "APPLYING"].includes(row.status)) throw error("MASS_QUEUE_SNAPSHOT_IDENTITY_INCOMPLETE", "Complete all snapshot pages before applying");
    const creator = await db.creatorAccount.findUnique({ where: { id: actor.creatorId }, select: { remoteId: true } });
    if ((creator.remoteId || null) !== row.providerId) throw error("MASS_QUEUE_SNAPSHOT_PROVIDER_CHANGED", "Provider identity changed during the observation");
    await db.$executeRawUnsafe(`UPDATE "MassCreatorDeliveryState" SET "activeSequence"=$2,"activeObservationId"=$3 WHERE "creatorId"=$1`, actor.creatorId, row.sequence, row.id);
    if (row.phase === "FINAL") {
      const [count] = await db.$queryRawUnsafe(`SELECT count(*)::int AS debt FROM "AutomationDelivery" WHERE ${CURRENT_PREDICATE} AND "agencyId"=$1 AND "creatorId"=$2`, actor.agencyId, actor.creatorId);
      const proven = actor.purpose === "RETIREMENT" && row.itemCount === 0 && count.debt === 0;
      if (proven) await db.$executeRawUnsafe(`UPDATE "MassCreatorDeliveryState" SET "retirementProofId"=$2,"retirementProofRevision"="sourceRevision","retirementProofObservedAt"=$3,"retirementProviderId"=$4 WHERE "creatorId"=$1 AND "retirementId"=$5`, actor.creatorId, row.id, row.fenceAt, row.providerId, row.retirementId);
      const response = { ok: true, applied: true, protocol: PROTOCOL, purpose: row.purpose, snapshotFenceToken: row.id,
        retirementId: row.retirementId, retirementCreated: row.retirementId === row.id, retirementProven: proven, pending: row.pending, settled: row.settled, cancelSettled: row.cancelSettled,
        remainingDebt: count.debt, snapshotItemCount: row.itemCount, snapshotFenceAt: iso(row.fenceAt), observedAt: iso(row.fenceAt), acceptedAt: iso(row.acceptedAt), publishedAt: iso(now) };
      await db.$executeRawUnsafe(`UPDATE "MassQueueObservation" SET "status"='APPLIED',"publishedAt"=$2,"response"=$3::jsonb WHERE "id"=$1`, row.id, now, JSON.stringify(response));
      return response;
    }
    const progress = row.phase === "PRESENT" ? await applyPresent(db, row) : await applyCurrent(db, row);
    // Our own physical projection changes advance the revision too. Capture the
    // resulting revision atomically; any intervening external writer invalidates
    // the next page instead of hiding behind partial reconciliation progress.
    const updated = await ensureState(db, actor);
    await db.$executeRawUnsafe(`UPDATE "MassQueueObservation" SET "status"='APPLYING',"phase"=$2,"cursor"=$3,"sourceRevision"=$4,"pending"="pending"+$5,"settled"="settled"+$6,"cancelSettled"="cancelSettled"+$7 WHERE "id"=$1`,
      row.id, progress.phase, progress.cursor, updated.sourceRevision, progress.pending, progress.settled, progress.cancelSettled);
    return { ok: true, applied: false, protocol: PROTOCOL, snapshotFenceToken: row.id, phase: progress.phase };
  }, options);
}

async function releaseMassRetirement(input) {
  const actor = identity({ ...input, purpose: "RETIREMENT" });
  if (typeof input.retirementId !== "string" || !input.retirementId || input.retirementId.length > 180) throw error("MASS_RETIREMENT_ID_REQUIRED", "A specific retirement identity is required", 400);
  return runDbTransaction(root(input), async db => {
    await lockScope(db, actor);
    const state = await ensureState(db, actor);
    if (!state.retirementId) return { ok: true, released: false };
    if (state.retirementId !== input.retirementId) throw error("MASS_RETIREMENT_CHANGED", "A later retirement preparation owns this creator");
    if (input.abortOwnPreparation === true) {
      const owner = await session(db, actor, input.retirementId);
      if (owner.retirementId !== owner.id || BigInt(state.observationSequence) !== BigInt(owner.sequence)) {
        return { ok: true, released: false, reason: "LATER_OBSERVATION_OWNS_PREPARATION" };
      }
    }
    await db.$executeRawUnsafe(`UPDATE "MassCreatorDeliveryState" SET "retirementId"=NULL,"retirementStartedAt"=NULL,"retirementProofId"=NULL,"retirementProofRevision"=NULL,"retirementProofObservedAt"=NULL,"retirementProviderId"=NULL,"sourceRevision"="sourceRevision"+1,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE "creatorId"=$1`, actor.creatorId);
    return { ok: true, released: true };
  }, options);
}
async function runMassObservationRetention({ db = require("../prisma") } = {}) {
  return runDbTransaction(db, async tx => {
    const [row] = await tx.$queryRawUnsafe(`SELECT "id" FROM "MassQueueObservation" WHERE "retainUntil"<(clock_timestamp() AT TIME ZONE 'UTC') ORDER BY "retainUntil","id" LIMIT 1 FOR UPDATE SKIP LOCKED`);
    if (!row) return { processed: 0 };
    await tx.$executeRawUnsafe(`UPDATE "MassQueueObservation" SET "status"='EXPIRED' WHERE "id"=$1`, row.id);
    const items = await tx.$executeRawUnsafe(`DELETE FROM "MassQueueObservationItem" WHERE ("observationId","queueId") IN (SELECT "observationId","queueId" FROM "MassQueueObservationItem" WHERE "observationId"=$1 ORDER BY "queueId" LIMIT 500)`, row.id);
    const pages = await tx.$executeRawUnsafe(`DELETE FROM "MassQueueObservationPage" WHERE ("observationId","ordinal") IN (SELECT "observationId","ordinal" FROM "MassQueueObservationPage" WHERE "observationId"=$1 ORDER BY "ordinal" LIMIT 200)`, row.id);
    const done = await tx.$executeRawUnsafe(`DELETE FROM "MassQueueObservation" o WHERE o."id"=$1 AND NOT EXISTS (SELECT 1 FROM "MassQueueObservationItem" i WHERE i."observationId"=o."id") AND NOT EXISTS (SELECT 1 FROM "MassQueueObservationPage" p WHERE p."observationId"=o."id")`, row.id);
    return { processed: 1, items, pages, done };
  }, options);
}
async function assertMassRetirementRead({ db, agencyId, creatorId, userId, deviceId, member, capability, operation, retirementSnapshot, physicalRequest }) {
  const denied = () => error("MASS_RETIREMENT_READ_INVALID", "Retirement observation permits only its exact creator queue listing", 403);
  if (capability !== "read" || operation !== "messages.queue.list" || physicalRequest?.method !== "GET"
      || typeof physicalRequest.path !== "string" || !physicalRequest.path.startsWith("/api2/v2/messages/queue?")) throw denied();
  const url = new URL(physicalRequest.path, "https://onlyfans.com");
  if (url.pathname !== "/api2/v2/messages/queue" || url.hash
      || [...url.searchParams.keys()].some(k => !["limit", "offset"].includes(k))
      || url.searchParams.getAll("limit").length !== 1 || url.searchParams.getAll("offset").length !== 1
      || !/^\d+$/.test(url.searchParams.get("limit")) || !/^\d+$/.test(url.searchParams.get("offset"))
      || Number(url.searchParams.get("limit")) < 1 || Number(url.searchParams.get("limit")) > 100 || Number(url.searchParams.get("offset")) > MAX_ITEMS) throw denied();
  const rows = await db.$queryRawUnsafe(`SELECT m.*,o."expiresAt" FROM "MassQueueObservation" o
    JOIN "MassCreatorDeliveryState" s ON s."creatorId"=o."creatorId" AND s."agencyId"=o."agencyId" AND s."retirementId"=o."retirementId"
    JOIN "AgencyMember" m ON m."id"=o."memberId" AND m."agencyId"=o."agencyId" AND m."userId"=o."userId" AND m."accessEpoch"=o."accessEpoch"
    JOIN "User" u ON u."id"=m."userId" AND u."disabledAt" IS NULL
    JOIN "CreatorAccount" c ON c."id"=o."creatorId" AND c."agencyId"=o."agencyId" AND c."deletedAt" IS NULL
    WHERE o."id"=$1 AND o."agencyId"=$2 AND o."creatorId"=$3 AND o."userId"=$4 AND o."deviceId"=$5 AND o."memberId"=$6 AND o."accessEpoch"=$7
      AND o."purpose"='RETIREMENT' AND o."status"='OPEN' AND o."sourceRevision"=s."sourceRevision"
      AND o."expiresAt">clock_timestamp() AT TIME ZONE 'UTC' AND m."deletedAt" IS NULL AND m."deactivatedAt" IS NULL`,
    retirementSnapshot.snapshotFenceToken, agencyId, creatorId, userId, deviceId, String(member?.id || ""), Number(member?.accessEpoch || 0));
  const currentMember = rows[0];
  if (!currentMember || !require("../middleware/automation-permissions").canAccessCreator(currentMember, creatorId)
      || !await canUsePermission({ db, member: currentMember, key: "creators.manage" })) throw denied();
  return { allowed: true, recoverable: true, recovery: true, reason: "MASS_RETIREMENT_OBSERVATION", validUntil: currentMember.expiresAt };
}
async function listMassRetirementState(input) {
  const db = root(input);
  const member = await db.agencyMember.findFirst({ where: { id: input.memberId, userId: input.userId, agencyId: input.agencyId, accessEpoch: input.accessEpoch, deletedAt: null, deactivatedAt: null }, select: { id: true, userId: true, agencyId: true, role: true, roleKey: true, permissions: true, assignedCreators: true } });
  if (!member || !await canUsePermission({ db, member, key: "creators.manage" })) return { ok: true, canManage: false, creators: [], hasMore: false, nextCursor: null };
  const { hasBroadCreatorAccess, assignedCreatorIds } = require("../middleware/automation-permissions");
  const broad = hasBroadCreatorAccess(member);
  const cursor = typeof input.cursor === "string" ? input.cursor : "";
  const rows = await db.$queryRawUnsafe(`SELECT c."id" AS "creatorId",c."displayName",c."status",s."retirementId",
      (s."retirementId" IS NOT NULL AND s."retirementProofId" IS NOT NULL AND s."retirementProofRevision"=s."sourceRevision" AND s."retirementProviderId" IS NOT DISTINCT FROM c."remoteId") AS prepared
    FROM "CreatorAccount" c LEFT JOIN "MassCreatorDeliveryState" s ON s."creatorId"=c."id" AND s."agencyId"=c."agencyId"
    WHERE c."agencyId"=$1 AND c."deletedAt" IS NULL AND c."id">$2 AND NULLIF(btrim(c."remoteId"),'') IS NOT NULL
      AND ($3::boolean OR c."id" IN (SELECT jsonb_array_elements_text($4::jsonb)))
    ORDER BY c."id" LIMIT 51`, input.agencyId, cursor, broad, JSON.stringify(broad ? [] : assignedCreatorIds(member)));
  const creators = rows.slice(0, 50).map(row => ({ ...row, prepared: row.prepared === true }));
  return { ok: true, canManage: true, creators, hasMore: rows.length > 50, nextCursor: rows.length > 50 ? creators.at(-1).creatorId : null };
}
module.exports = { beginMassRemoteQueueSnapshot, appendMassRemoteQueueSnapshot, reconcileMassRemoteQueueSnapshot, releaseMassRetirement, runMassObservationRetention, assertMassRetirementRead, listMassRetirementState };
