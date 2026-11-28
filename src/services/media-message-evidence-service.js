"use strict";

// A complete provider message supplies attachment membership, independently of
// canonical money. Explicit fan ownership is durable negative evidence: an old
// Desktop may replay a fact, but cannot turn that attachment into creator work.
const { hashCanonicalJson } = require("./realtime-receipt-hash");
const MAX_MESSAGES = 2000, MAX_IDS = 100000;
const fail = (code, sourceKey, reason) => { throw Object.assign(new Error(code), { code, sourceKey, reason, status: 409 }); };
const text = value => typeof value === "string" && value.length > 0 && value.length <= 240
  && value.trim() === value && !/[\u0000-\u001f]/.test(value);
function identifiers(value, sourceKey) {
  if (!Array.isArray(value) || value.length > MAX_IDS) fail("MEDIA_USAGE_MEDIA_EVIDENCE_INVALID", sourceKey, "bounded media identity list required");
  for (let i = 0; i < value.length; i++) if (!text(value[i]) || (i && value[i - 1] >= value[i])) {
    fail("MEDIA_USAGE_MEDIA_EVIDENCE_INVALID", sourceKey, "media identities must be unique and ordered");
  }
  return value;
}

function normalizeMessageMediaEvidence(value, sourceKey) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) fail("MEDIA_USAGE_MEDIA_EVIDENCE_INVALID", sourceKey, "bounded message evidence required");
  const seen = new Set(); let total = 0;
  return value.map(row => {
    if (!row || row.version !== 1 || row.complete !== true || !text(row.dialogId) || !text(row.messageId) || seen.has(row.messageId)) {
      fail("MEDIA_USAGE_MEDIA_EVIDENCE_INVALID", sourceKey, "exact complete message evidence required");
    }
    const creatorMediaIds = identifiers(row.creatorMediaIds, sourceKey), excludedMediaIds = identifiers(row.excludedMediaIds, sourceKey);
    const excluded = new Set(excludedMediaIds);
    if (creatorMediaIds.some(id => excluded.has(id))) fail("MEDIA_USAGE_MEDIA_OWNERSHIP_CONFLICT", sourceKey, "one attachment has conflicting owners");
    total += creatorMediaIds.length + excludedMediaIds.length;
    if (total > MAX_IDS) fail("MEDIA_USAGE_MEDIA_EVIDENCE_INVALID", sourceKey, "bounded evidence page required");
    seen.add(row.messageId);
    return { version: 1, complete: true, dialogId: row.dialogId, messageId: row.messageId, creatorMediaIds, excludedMediaIds };
  });
}

function prepared(row) {
  return { ...row, creatorIndex: new Map(row.creatorMediaIds.map((id, index) => [id, index])), excluded: new Set(row.excludedMediaIds) };
}

async function publishMessageMediaEvidence(db, { agencyId, creatorId, sourceKey, evidence }) {
  if (!evidence.length) return 0;
  for (const row of evidence) if (sourceKey !== require("./media-financial-projection-service").sourceKey(creatorId, row.dialogId)) {
    fail("MEDIA_USAGE_MEDIA_EVIDENCE_SCOPE_MISMATCH", sourceKey, "message belongs to another dialog source");
  }
  const prior = await db.$queryRawUnsafe(`SELECT * FROM "CreatorMediaMessageEvidence"
    WHERE "agencyId"=$1 AND "creatorId"=$2 AND "sourceKey"=$3 AND "messageId"=ANY($4::text[])`,
  agencyId, creatorId, sourceKey, evidence.map(row => row.messageId));
  const byId = new Map(prior.map(row => [row.messageId, row])), writes = [];
  for (const incoming of evidence) {
    const before = byId.get(incoming.messageId), excluded = new Set(before?.excludedMediaIds || []);
    if (incoming.creatorMediaIds.some(id => excluded.has(id))) {
      fail("MEDIA_USAGE_MEDIA_OWNERSHIP_CONFLICT", sourceKey, "previously excluded fan media cannot become creator media");
    }
    for (const id of incoming.excludedMediaIds) excluded.add(id);
    const eligible = new Set([...(before?.creatorMediaIds || []), ...incoming.creatorMediaIds]);
    for (const id of excluded) eligible.delete(id);
    if (eligible.size + excluded.size > MAX_IDS) fail("MEDIA_USAGE_MEDIA_EVIDENCE_INVALID", sourceKey, "message evidence exceeds bounded attachment capacity");
    const row = { version: 1, dialogId: incoming.dialogId, messageId: incoming.messageId,
      creatorMediaIds: [...eligible].sort(), excludedMediaIds: [...excluded].sort() };
    row.manifestHash = hashCanonicalJson(row);
    if (before?.manifestHash !== row.manifestHash) writes.push(row);
  }
  if (!writes.length) return 0;
  await db.$executeRawUnsafe(`INSERT INTO "CreatorMediaMessageEvidence"
    ("agencyId","creatorId","sourceKey","messageId","dialogId","creatorMediaIds","excludedMediaIds",version,"manifestHash")
    SELECT $1,$2,$3,x."messageId",x."dialogId",x."creatorMediaIds",x."excludedMediaIds",1,x."manifestHash"
    FROM jsonb_to_recordset($4::jsonb) x("messageId" text,"dialogId" text,"creatorMediaIds" jsonb,"excludedMediaIds" jsonb,"manifestHash" text)
    ON CONFLICT ("creatorId","sourceKey","messageId") DO UPDATE SET
      "creatorMediaIds"=EXCLUDED."creatorMediaIds","excludedMediaIds"=EXCLUDED."excludedMediaIds","manifestHash"=EXCLUDED."manifestHash",
      dirty=TRUE,"pendingFacts"=TRUE,cursor='',"updatedAt"=clock_timestamp()`, agencyId, creatorId, sourceKey, JSON.stringify(writes));
  await require("./domain-work-authority-service").publishDomainWork({ db, agencyId, creatorId,
    workClass: "MEDIA_FINANCIAL_PROJECTION", objectType: "CreatorAccount", objectId: creatorId, partitionKey: creatorId });
  return writes.length;
}

async function evidenceForFacts(db, { agencyId, creatorId }, facts) {
  const keys = [...new Map(facts.map(row => { const messageId = row.sourceMessageId || row.messageId;
    return [JSON.stringify([row.sourceKey, messageId]), { sourceKey: row.sourceKey, messageId }]; })).values()];
  if (!keys.length) return new Map();
  const rows = await db.$queryRawUnsafe(`SELECT s.* FROM "CreatorMediaMessageEvidence" s
    JOIN jsonb_to_recordset($3::jsonb) x("sourceKey" text,"messageId" text) ON s."sourceKey"=x."sourceKey" AND s."messageId"=x."messageId"
    WHERE s."agencyId"=$1 AND s."creatorId"=$2`, agencyId, creatorId, JSON.stringify(keys));
  return new Map(rows.map(row => [JSON.stringify([row.sourceKey, row.messageId]), prepared(row)]));
}

async function refreshEvidenceCompleteness(db, { agencyId, creatorId, sourceKey, messageIds }) {
  if (!messageIds.length) return;
  // A complete provider manifest can span fact pages. Do not call the money
  // projection ready until every eligible attachment has actually arrived.
  // Each anti-lookup uses the immutable fact identity, never a history scan.
  await db.$executeRawUnsafe(`UPDATE "CreatorMediaMessageEvidence" e SET "pendingFacts"=EXISTS(
    SELECT 1 FROM jsonb_array_elements_text(e."creatorMediaIds") id
      WHERE NOT EXISTS(SELECT 1 FROM "CreatorMediaUsageFact" f WHERE f."agencyId"=e."agencyId"
        AND f."creatorId"=e."creatorId" AND f."sourceKey"=e."sourceKey" AND f."sourceMessageId"=e."messageId" AND f."mediaId"=id.value))
    WHERE e."agencyId"=$1 AND e."creatorId"=$2 AND e."sourceKey"=$3 AND e."messageId"=ANY($4::text[])`,
  agencyId, creatorId, sourceKey, messageIds);
}

module.exports = { normalizeMessageMediaEvidence, publishMessageMediaEvidence, evidenceForFacts, refreshEvidenceCompleteness, prepared };
