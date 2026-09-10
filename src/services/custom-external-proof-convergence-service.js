"use strict";

const { recoverConfirmedRelayProjectionForSubmission } = require("./custom-content-submissions-service");
const { confirmedRelayProofMediaIdForSubmission } = require("./custom-relay-result-proof-service");
const { customExternalWriteClassification } = require("./custom-content-pipeline-authority-service");
const { DEBT } = require("./provider-operational-debt-authority-service");

const DEFAULT_BATCH_SIZE = 200;
const FALLBACK_PAGE_SIZE = 200;

function clean(value, max = 500) { return String(value == null ? "" : value).trim().slice(0, max); }
function bounded(value, fallback = DEFAULT_BATCH_SIZE, max = 1000) {
  const n = Math.floor(Number(value) || fallback);
  return Math.max(1, Math.min(max, n));
}

async function discoverHistoricalRelayProjectionDebt({ agencyId = null, cursor = null, limit = DEFAULT_BATCH_SIZE, db } = {}) {
  const take = bounded(limit);
  if (!db) throw new Error("Custom external proof convergence requires a database");

  if (typeof db.$queryRawUnsafe === "function") {
    // No CreatorAccount/Agency liveness join by design. A validated provider fact is
    // historical truth even after creator/order/submission business terminality.
    // The SQL mirrors the exact relay proof binding closely enough to keep malformed
    // rows out of the executable repair horizon; the JS validator still re-proves
    // every result before projection.
    return db.$queryRawUnsafe(
      `SELECT submission."id", submission."agencyId"
       FROM "CustomContentSubmission" AS submission
       JOIN "AutomationDelivery" AS relay
         ON relay."agencyId" = submission."agencyId"
        AND relay."creatorId" = submission."creatorId"
        AND relay."actionType" = 'CUSTOM_RELAY_SEND'
        AND relay."status" = 'COMPLETED'
        AND relay."idempotencyKey" = ('custom-relay:' || submission."id" || ':' || cardinality(submission."ofMediaIds")::text)
        AND relay."payload"->>'submissionId' = submission."id"
        AND (relay."payload"->>'expectedIndex') ~ '^[0-9]+$'
        AND (relay."payload"->>'expectedIndex')::integer = cardinality(submission."ofMediaIds")
        AND relay."payload"->>'telegramSourceAccountId' = submission."telegramSourceAccountId"
        AND relay."payload"->>'telegramSourceUserId' = submission."telegramSourceUserId"
        AND relay."payload"->>'telegramMessageId' = submission."telegramMessageIds"[cardinality(submission."ofMediaIds") + 1]::text
        AND relay."result"->>'programmaticWriteKind' = 'CUSTOM_RELAY_SEND'
        AND relay."result"->>'mediaId' ~ '^[1-9][0-9]{0,39}$'
       WHERE cardinality(submission."ofMediaIds") < cardinality(submission."telegramMessageIds")
         AND NOT ((relay."result"->>'mediaId') = ANY(submission."ofMediaIds"))
         AND ($1::text IS NULL OR submission."agencyId"=$1)
         AND ($2::text IS NULL OR submission."id">$2)
       ORDER BY submission."id" ASC
       LIMIT ${take}`,
      agencyId ? String(agencyId) : null, cursor ? String(cursor) : null,
    );
  }

  // Test/adapter fallback: cursor to exhaustion until enough VALID exact proofs are
  // found. LIMIT is applied after proof validation, never before it, so malformed
  // historical rows cannot starve a later convergent row.
  const found = [];
  let scanCursor = cursor ? String(cursor) : null;
  while (found.length < take) {
    const rows = await db.customContentSubmission.findMany({
      where: { ...(agencyId ? { agencyId: String(agencyId) } : {}) },
      select: {
        id: true, agencyId: true, creatorId: true, customOrderId: true, ofMediaIds: true,
        telegramMessageIds: true, telegramSourceAccountId: true, telegramSourceUserId: true,
      },
      orderBy: { id: "asc" },
      take: FALLBACK_PAGE_SIZE,
      ...(scanCursor ? { cursor: { id: scanCursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    scanCursor = rows[rows.length - 1].id;
    for (const submission of rows) {
      const current = Array.isArray(submission.ofMediaIds) ? submission.ofMediaIds.map(String).filter(Boolean) : [];
      const source = Array.isArray(submission.telegramMessageIds) ? submission.telegramMessageIds : [];
      if (current.length >= source.length) continue;
      const proof = await db.automationDelivery?.findFirst?.({
        where: {
          agencyId: submission.agencyId,
          creatorId: submission.creatorId,
          actionType: "CUSTOM_RELAY_SEND",
          status: "COMPLETED",
          idempotencyKey: `custom-relay:${submission.id}:${current.length}`,
        },
        select: { id: true, idempotencyKey: true, actionType: true, status: true, payload: true, result: true },
      });
      if (!confirmedRelayProofMediaIdForSubmission({ row: proof, submission })) continue;
      found.push({ id: String(submission.id), agencyId: String(submission.agencyId) });
      if (found.length >= take) break;
    }
    if (rows.length < FALLBACK_PAGE_SIZE) break;
  }
  return found;
}

async function convergeHistoricalCustomExternalProofs({ agencyId = null, cursor = null, limit = DEFAULT_BATCH_SIZE, db } = {}) {
  const rows = await discoverHistoricalRelayProjectionDebt({ agencyId, cursor, limit, db });
  const result = { ok: true, selected: rows.length, repaired: 0, projectedMedia: 0, failed: 0, failures: [] };
  for (const candidate of rows) {
    try {
      const repaired = await recoverConfirmedRelayProjectionForSubmission({
        agencyId: String(candidate.agencyId), submissionId: String(candidate.id), db,
      });
      if (Number(repaired?.recovered || 0) > 0) {
        result.repaired += 1;
        result.projectedMedia += Number(repaired.recovered || 0);
      }
    } catch (error) {
      result.ok = false;
      result.failed += 1;
      result.failures.push({ submissionId: String(candidate.id), agencyId: String(candidate.agencyId), code: clean(error?.code || "CUSTOM_EXTERNAL_PROOF_CONVERGENCE_FAILED", 120), message: clean(error?.message || error, 500) });
    }
  }
  result.nextCursor = rows.length ? String(rows[rows.length - 1].id) : (cursor ? String(cursor) : null);
  result.complete = rows.length < bounded(limit);
  return result;
}


async function repairCustomExternalProjectionWorkItem({ agencyId, deliveryId, db } = {}) {
  const scopedAgencyId = clean(agencyId, 180);
  const scopedDeliveryId = clean(deliveryId, 220);
  if (!scopedAgencyId || !scopedDeliveryId) {
    const error = new Error("Custom external projection work identity is required");
    error.code = "CUSTOM_EXTERNAL_WORK_IDENTITY_REQUIRED";
    throw error;
  }
  if (!db?.automationDelivery?.findFirst) {
    const error = new Error("AutomationDelivery storage is required");
    error.code = "CUSTOM_EXTERNAL_AUTOMATION_DELIVERY_STORAGE_REQUIRED";
    throw error;
  }

  // ProviderOperationalDebt is intentionally only the provider-retention/capability
  // projection. Execution ownership belongs to DomainWorkItem keyed by this exact
  // AutomationDelivery, so this worker never scans the debt table for "some work".
  const delivery = await db.automationDelivery.findFirst({
    where: { id: scopedDeliveryId, agencyId: scopedAgencyId },
  });
  if (!delivery || String(delivery.status || "") !== "COMPLETED" || !["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"].includes(String(delivery.actionType || ""))) {
    if (db?.providerOperationalDebt?.deleteMany) {
      await db.providerOperationalDebt.deleteMany({
        where: { agencyId: scopedAgencyId, debtClass: DEBT.CUSTOM_EXTERNAL_PROJECTION_DEBT, objectType: "AutomationDelivery", objectId: scopedDeliveryId },
      });
    }
    return { ok: true, obsolete: true, repaired: 0, cleared: 1, converged: true };
  }

  const payload = delivery.payload && typeof delivery.payload === "object" && !Array.isArray(delivery.payload) ? delivery.payload : {};
  const result = delivery.result && typeof delivery.result === "object" && !Array.isArray(delivery.result) ? delivery.result : {};
  const submissionId = clean(
    payload.submissionId || result.submissionId || (String(delivery.actionType) === "CUSTOM_RELAY_SEND" ? String(delivery.targetId || "").split(":")[0] : ""),
    180,
  );
  const orderId = clean(
    payload.customOrderId || result.customOrderId || (String(delivery.actionType) === "CUSTOM_MANUAL_SEND" ? delivery.targetId : ""),
    180,
  );

  let repaired = 0;
  if (String(delivery.actionType) === "CUSTOM_RELAY_SEND" && submissionId) {
    const projection = await recoverConfirmedRelayProjectionForSubmission({ agencyId: scopedAgencyId, submissionId, db });
    repaired += Number(projection?.recovered || 0);
  }

  const [submission, order] = await Promise.all([
    submissionId && db.customContentSubmission?.findFirst
      ? db.customContentSubmission.findFirst({ where: { id: submissionId, agencyId: scopedAgencyId, creatorId: delivery.creatorId } })
      : Promise.resolve(null),
    orderId && db.customOrder?.findFirst
      ? db.customOrder.findFirst({ where: { id: orderId, agencyId: scopedAgencyId, creatorId: delivery.creatorId } })
      : Promise.resolve(null),
  ]);
  const classification = customExternalWriteClassification({ delivery, submission, order });
  if (classification.converged && db?.providerOperationalDebt?.deleteMany) {
    await db.providerOperationalDebt.deleteMany({
      where: { agencyId: scopedAgencyId, debtClass: DEBT.CUSTOM_EXTERNAL_PROJECTION_DEBT, objectType: "AutomationDelivery", objectId: scopedDeliveryId },
    });
  }
  return {
    ok: true,
    obsolete: false,
    repaired,
    cleared: classification.converged ? 1 : 0,
    converged: Boolean(classification.converged),
    classification,
  };
}


module.exports = {
  DEFAULT_BATCH_SIZE,
  discoverHistoricalRelayProjectionDebt,
  convergeHistoricalCustomExternalProofs,
  repairCustomExternalProjectionWorkItem,
};
