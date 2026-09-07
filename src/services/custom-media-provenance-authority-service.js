"use strict";

const { uniqueMediaIds } = require("./custom-content-library-service");
const { confirmedRelayProofMediaIdForSubmission } = require("./custom-relay-result-proof-service");

const RELAY_PROOF_MEDIA_QUERY_CHUNK = 50;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 500) { return String(value == null ? "" : value).trim().slice(0, max); }

function normalizeMediaIds(values, max = 500) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const id = clean(raw, 240);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > max) throw fail("CUSTOM_DELIVERY_MEDIA_LIMIT", `Too many media IDs for one CUSTOM provenance check (max ${max})`, 413);
  return out;
}

function addReference(referencesByMedia, mediaIdInput, submissionIdInput, orderIdInput, source) {
  const mediaId = clean(mediaIdInput, 240);
  const submissionId = clean(submissionIdInput, 180);
  const orderId = clean(orderIdInput, 180);
  if (!mediaId || !submissionId) return;
  let refs = referencesByMedia.get(mediaId);
  if (!refs) { refs = new Map(); referencesByMedia.set(mediaId, refs); }
  const key = `${submissionId}\n${orderId}`;
  const current = refs.get(key);
  const sources = new Set(current?.sources || []);
  sources.add(String(source || "UNKNOWN"));
  refs.set(key, { submissionId, orderId: orderId || null, sources: [...sources] });
}

/**
 * Canonical CUSTOM media provenance authority.
 *
 * CUSTOM identity is monotonic historical fact. The strongest source is a
 * validated provider-completed CUSTOM_RELAY_SEND result; product projections
 * (CustomContentSubmission.ofMediaIds and CreatorMediaAsset) are faster/derived
 * sources but are never allowed to temporarily downgrade a proven external fact
 * to GENERAL during a crash/recovery window.
 */
async function resolveCustomMediaProvenance({ agencyId, creatorId, mediaIds, db, maxMediaIds = 500 } = {}) {
  const client = db || require("../prisma");
  const creator = clean(creatorId, 180);
  if (!agencyId || !creator) throw fail("CUSTOM_DELIVERY_PREFLIGHT_CONTEXT_REQUIRED", "agencyId and creatorId are required");
  const attemptedMediaIds = normalizeMediaIds(mediaIds, maxMediaIds);
  if (!attemptedMediaIds.length) {
    return { attemptedMediaIds, customIds: new Set(), customAssets: [], provenanceRows: [], referencesByMedia: new Map(), evidenceByMedia: new Map() };
  }

  const requested = new Set(attemptedMediaIds);
  const customIds = new Set();
  const referencesByMedia = new Map();
  const evidenceByMedia = new Map();
  const mark = (mediaIdInput, source) => {
    const mediaId = clean(mediaIdInput, 240);
    if (!mediaId || !requested.has(mediaId)) return;
    customIds.add(mediaId);
    let sources = evidenceByMedia.get(mediaId);
    if (!sources) { sources = new Set(); evidenceByMedia.set(mediaId, sources); }
    sources.add(source);
  };

  // Derived typed projection. Fast path only; never the sole authority.
  const customAssets = client.creatorMediaAsset?.findMany ? await client.creatorMediaAsset.findMany({
    where: { agencyId, creatorId: creator, source: "CUSTOM", mediaId: { in: attemptedMediaIds } },
    select: { mediaId: true, customOrderId: true, customSubmissionId: true },
    take: attemptedMediaIds.length,
  }) : [];
  for (const asset of customAssets || []) {
    const mediaId = clean(asset.mediaId, 240);
    mark(mediaId, "CREATOR_MEDIA_ASSET");
    addReference(referencesByMedia, mediaId, asset.customSubmissionId, asset.customOrderId, "CREATOR_MEDIA_ASSET");
  }

  // Canonical product projection. Historical CUSTOM remains CUSTOM regardless of
  // current pipeline disposition/order lifecycle.
  let missing = attemptedMediaIds.filter((mediaId) => !customIds.has(mediaId));
  const projectedRows = missing.length && client.customContentSubmission?.findMany ? await client.customContentSubmission.findMany({
    where: { agencyId, creatorId: creator, ofMediaIds: { hasSome: missing } },
    select: { id: true, customOrderId: true, ofMediaIds: true, telegramMessageIds: true, telegramSourceAccountId: true, telegramSourceUserId: true },
  }) : [];
  for (const row of projectedRows || []) {
    for (const mediaId of uniqueMediaIds(row.ofMediaIds)) {
      if (!requested.has(mediaId)) continue;
      mark(mediaId, "SUBMISSION_PROJECTION");
      addReference(referencesByMedia, mediaId, row.id, row.customOrderId, "SUBMISSION_PROJECTION");
    }
  }

  // Strongest authority: exact validated provider proof. This intentionally runs
  // only for still-unclassified IDs, but its result is historical and independent
  // of active creator/runtime/capability state.
  missing = attemptedMediaIds.filter((mediaId) => !customIds.has(mediaId));
  const proofCandidates = [];
  if (missing.length && client.automationDelivery?.findMany) {
    for (let offset = 0; offset < missing.length; offset += RELAY_PROOF_MEDIA_QUERY_CHUNK) {
      const chunk = missing.slice(offset, offset + RELAY_PROOF_MEDIA_QUERY_CHUNK);
      const rows = await client.automationDelivery.findMany({
        where: {
          agencyId,
          creatorId: creator,
          actionType: "CUSTOM_RELAY_SEND",
          status: "COMPLETED",
          OR: chunk.map((mediaId) => ({ result: { path: ["mediaId"], equals: mediaId } })),
        },
        select: { id: true, idempotencyKey: true, actionType: true, status: true, payload: true, result: true },
      });
      proofCandidates.push(...(rows || []));
    }
  }

  const candidateSubmissionIds = [...new Set(proofCandidates.map((row) => clean(row?.payload?.submissionId, 180)).filter(Boolean))];
  const proofSubmissions = candidateSubmissionIds.length && client.customContentSubmission?.findMany ? await client.customContentSubmission.findMany({
    where: { id: { in: candidateSubmissionIds }, agencyId, creatorId: creator },
    select: { id: true, customOrderId: true, ofMediaIds: true, telegramMessageIds: true, telegramSourceAccountId: true, telegramSourceUserId: true },
  }) : [];
  const proofSubmissionById = new Map((proofSubmissions || []).map((row) => [clean(row.id, 180), row]));
  for (const proof of proofCandidates) {
    const submission = proofSubmissionById.get(clean(proof?.payload?.submissionId, 180));
    const provenMediaId = confirmedRelayProofMediaIdForSubmission({ row: proof, submission });
    if (!provenMediaId || !requested.has(provenMediaId)) continue;
    mark(provenMediaId, "CONFIRMED_RELAY_PROOF");
    addReference(referencesByMedia, provenMediaId, submission.id, submission.customOrderId, "CONFIRMED_RELAY_PROOF");
  }

  const submissionById = new Map();
  for (const row of [...(projectedRows || []), ...(proofSubmissions || [])]) submissionById.set(clean(row.id, 180), row);
  return {
    attemptedMediaIds,
    customIds,
    customAssets: customAssets || [],
    provenanceRows: [...submissionById.values()],
    referencesByMedia,
    evidenceByMedia,
  };
}

async function classifyProgrammaticCustomMediaProvenance({ agencyId, creatorId, mediaIds, db = null } = {}) {
  const provenance = await resolveCustomMediaProvenance({ agencyId, creatorId, mediaIds, db, maxMediaIds: 200 });
  const customMediaIds = provenance.attemptedMediaIds.filter((mediaId) => provenance.customIds.has(mediaId));
  if (!customMediaIds.length) return { ok: true, matched: false, allow: true, code: null, customMediaIds: [] };
  return {
    ok: true,
    matched: true,
    allow: false,
    code: "CUSTOM_MEDIA_PROGRAMMATIC_FORBIDDEN",
    error: "CUSTOM media may only be sent through the exact Custom delivery flow, never through automation/campaign programmatic writers",
    customMediaIds,
  };
}

module.exports = {
  normalizeMediaIds,
  resolveCustomMediaProvenance,
  classifyProgrammaticCustomMediaProvenance,
};
