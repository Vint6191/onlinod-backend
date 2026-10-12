"use strict";

// Durable message intent, not an audit/diagnostic blob. compactJson deliberately
// truncates strings and may return {}; neither behavior is valid for a message.
function invalid(message) {
  return Object.assign(new Error(message), { code: "AUTOMATION_BUMP_CONTENT_INVALID", status: 400 });
}
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : {};

function normalizeBumpContent(input = {}) {
  const messageText = String(input.messageText ?? input.text ?? "").trim();
  if (messageText.length > 12000) throw invalid("Message text cannot exceed 12,000 characters.");
  const price = Number(input.price ?? (Number(input.priceCents ?? 0) / 100));
  const priceCents = Math.round(price * 100);
  if (!Number.isFinite(price) || price < 0 || !Number.isSafeInteger(priceCents) || priceCents > 2147483647)
    throw invalid("Enter a valid price.");
  const currency = String(input.currency || "USD").trim().toUpperCase();
  if (currency !== "USD") throw invalid("Bump prices must use USD.");
  const selected = input.media ?? input.mediaFiles ?? [];
  if (!Array.isArray(selected)) throw invalid("Select valid Vault media.");
  const media = [], seen = new Set();
  for (const value of selected) {
    const source = object(value), raw = { ...object(source.raw), ...source };
    const id = String(typeof value === "object" ? raw.id ?? raw.mediaId ?? raw.media_id ?? raw.fileId ?? "" : value);
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)
      throw invalid("Selected media must have a valid Vault ID.");
    const canonicalId = String(Number(id));
    if (seen.has(canonicalId)) continue;
    seen.add(canonicalId);
    const files = object(raw.files);
    const thumb = String(raw.thumb || raw.thumbUrl || raw.previewUrl || object(files.thumb).url || object(files.preview).url || "");
    media.push({ id: canonicalId, type: String(raw.type || raw.mediaType || "media").slice(0, 40),
      thumb: /^https?:\/\//i.test(thumb) && thumb.length <= 4096 ? thumb : "",
      duration: Number.isFinite(Number(raw.duration)) ? Math.max(0, Number(raw.duration)) : 0 });
  }
  // This is the existing storage cardinality, now explicit instead of silently
  // discarding every attachment after the 200th in generic JSON pruning.
  if (media.length > 200) throw invalid("Select at most 200 media items per bump.");
  return { schemaVersion: 1, messageText, price: priceCents / 100, priceCents, currency,
    lockedText: priceCents > 0 && (input.lockedText === true || input.paidMode === "paid_text"), media };
}

module.exports = { normalizeBumpContent };
