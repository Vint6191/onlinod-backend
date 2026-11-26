"use strict";

const crypto = require("node:crypto");
const FORMAT_VERSION = 1;
const MAX_PARTS = 64;
const BODY_UNITS = 4000;
const digest = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const invalid = message => Object.assign(new Error(message), { code: "CUSTOM_INSTRUCTION_MANIFEST_INVALID", status: 409 });

function partId(parentId, index) {
  if (index === 0) return String(parentId);
  const hex = digest(`custom-instruction-part:v1:${parentId}:${index}`);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// JavaScript/Telegram text limits use UTF-16 units. Never split a surrogate pair,
// strip whitespace, or silently omit a suffix. Numbering is outside the accepted body.
function buildInstructionManifest(parentId, fullText) {
  if (typeof fullText !== "string" || !fullText.trim()) throw invalid("An instruction must contain text");
  const bodies = [];
  for (let start = 0; start < fullText.length;) {
    let end = Math.min(start + BODY_UNITS, fullText.length);
    if (end < fullText.length && /[\uD800-\uDBFF]/.test(fullText[end - 1]) && /[\uDC00-\uDFFF]/.test(fullText[end])) end -= 1;
    bodies.push(fullText.slice(start, end)); start = end;
    if (bodies.length > MAX_PARTS) throw invalid("Instruction exceeds the supported complete-message manifest size");
  }
  const parts = bodies.map((body, index) => {
    const text = bodies.length === 1 ? body : `[${index + 1}/${bodies.length}]\n${body}`;
    return { id: partId(parentId, index), index, body, text, hash: digest(text) };
  });
  return { formatVersion: FORMAT_VERSION, parentId: String(parentId), contentHash: digest(fullText), fullText, parts,
    state: "PENDING", confirmedParts: 0, completedAt: null };
}

function readInstructionManifest(row) {
  const value = row?.instructionManifest;
  if (value == null) return null;
  if (!value || typeof value !== "object" || value.formatVersion !== FORMAT_VERSION || value.parentId !== String(row.id)
      || !["TASK", "REVISION_REQUEST", "INSTRUCTION_CONTINUATION"].includes(String(row.kind)) || !Array.isArray(value.parts)
      || value.parts.length < 1 || value.parts.length > MAX_PARTS || typeof value.fullText !== "string"
      || digest(value.fullText) !== value.contentHash) throw invalid("Instruction manifest identity or content hash is invalid");
  let reconstructed = "";
  for (const [index, part] of value.parts.entries()) {
    if (!part || part.id !== partId(row.id, index) || part.index !== index || typeof part.body !== "string"
        || typeof part.text !== "string" || part.text.length > 4096 || !part.text.trim()
        || part.text !== (value.parts.length === 1 ? part.body : `[${index + 1}/${value.parts.length}]\n${part.body}`)
        || digest(part.text) !== part.hash) throw invalid("Instruction manifest part is invalid");
    reconstructed += part.body;
  }
  if (reconstructed !== value.fullText) throw invalid("Instruction manifest does not contain the complete accepted text");
  return value;
}

function instructionDeliveryState(row) {
  const manifest = readInstructionManifest(row);
  if (!manifest) return String(row?.state || "");
  if (manifest.state === "COMPLETE" && manifest.confirmedParts === manifest.parts.length && manifest.completedAt) return "CONFIRMED";
  if (manifest.state === "UNKNOWN") return "RECONCILE_REQUIRED";
  if (manifest.state === "CANCELLED") return "CANCELLED";
  if (["COMMITTING", "RECONCILE_REQUIRED", "CANCELLED"].includes(String(row.state))) return String(row.state);
  return manifest.state === "SENDING" ? "CLAIMED" : "PLANNED";
}

function instructionPayload(payload, manifest, index) {
  const part = manifest.parts[index];
  if (!part) throw invalid("Instruction part is absent");
  return { ...payload, text: part.text, instructionParentId: manifest.parentId,
    instructionPartIndex: index, instructionContentHash: manifest.contentHash, instructionPartHash: part.hash };
}

function assertInstructionPart(row, parent) {
  const manifest = readInstructionManifest(parent);
  if (!manifest) throw invalid("Instruction parent has no manifest");
  const index = row.id === parent.id ? 0 : Number(row.instructionPartIndex);
  const part = manifest.parts[index];
  if (!part || part.id !== String(row.id) || (index > 0 && (row.kind !== "INSTRUCTION_PART" || row.instructionParentId !== parent.id))
      || String(row.agencyId) !== String(parent.agencyId) || String(row.creatorId) !== String(parent.creatorId)
      || String(row.customOrderId) !== String(parent.customOrderId) || String(row.accountId) !== String(parent.accountId)
      || String(row.customSubmissionId || "") !== String(parent.customSubmissionId || "")
      || row.payload?.text !== part.text || row.payload?.instructionParentId !== parent.id
      || row.payload?.instructionPartIndex !== index || row.payload?.instructionContentHash !== manifest.contentHash
      || row.payload?.instructionPartHash !== part.hash) throw invalid("Physical delivery differs from its canonical instruction part");
  return { manifest, part, index };
}

function assertInstructionCapability(row, version) {
  if ((row?.kind === "INSTRUCTION_CONTINUATION" || row?.instructionParentId || readInstructionManifest(row)?.parts.length > 1) && Number(version) !== FORMAT_VERSION) {
    throw Object.assign(new Error("Update Desktop to deliver this complete multipart instruction"), { code: "CUSTOM_INSTRUCTION_CLIENT_UPGRADE_REQUIRED", status: 409 });
  }
}

async function effectiveInstruction(source, db, agencyId = source?.agencyId) {
  if (!source || source.kind === "INSTRUCTION_CONTINUATION" || !source.id || !agencyId || !db?.telegramDeliveryIntent?.findFirst) return source;
  const scoped = source.customOrderId ? source : await db.telegramDeliveryIntent.findFirst({ where: { agencyId, id: source.id } });
  if (!scoped?.customOrderId) return source;
  const where = { logicalKey: `custom-telegram:${agencyId}:${scoped.customOrderId}:INSTRUCTION_CONTINUATION:${source.id}` };
  const continuation = db.telegramDeliveryIntent.findUnique ? await db.telegramDeliveryIntent.findUnique({ where })
    : await db.telegramDeliveryIntent.findFirst({ where: { agencyId, kind: "INSTRUCTION_CONTINUATION", ...where } });
  if (!continuation || continuation.kind !== "INSTRUCTION_CONTINUATION") return source;
  if (continuation.payload?.sourceIntentId !== String(source.id)
      || source.customOrderId && continuation.customOrderId !== source.customOrderId
      || source.creatorId && continuation.creatorId !== source.creatorId
      || source.accountId && continuation.accountId !== source.accountId) throw invalid("Continuation has a different canonical source");
  readInstructionManifest(continuation);
  return continuation;
}

module.exports = { FORMAT_VERSION, MAX_PARTS, buildInstructionManifest, readInstructionManifest, instructionDeliveryState,
  instructionPayload, assertInstructionPart, assertInstructionCapability, effectiveInstruction };
