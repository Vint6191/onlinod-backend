"use strict";

const TERMINAL_DIALOG_CODES = new Set([
  "DIALOG_BATCH_ITEM_ID_MISSING",
  "DIALOG_EMPTY",
  "DIALOG_EMPTY_RESPONSE_UNCONFIRMED",
  "DIALOG_NOT_FOUND",
  "DIALOG_TARGET_NOT_FOUND",
  "USER_NOT_FOUND",
]);

const TERMINAL_DIALOG_HTTP_STATUSES = new Set([403, 404, 410]);

// These are only phrases that mean the target itself is unavailable. Keep the
// list deliberately narrow: transport failures, timeouts and backend errors
// must remain retryable/FAILED instead of being silently hidden.
const TERMINAL_DIALOG_TEXT_MARKERS = [
  "user not found",
  "geo block",
  "geoblock",
  "region-restricted",
  "region restricted",
  "user deleted",
  "user is deleted",
  "user blocked",
  "user is blocked",
  "dialog not found",
  "chat not found",
  "target not found",
  "no longer available",
];

function clean(value, max = 2_000) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, max) : "";
}

function normalizeCode(value) {
  return clean(value, 120).toUpperCase();
}

function normalizeStatus(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 599 ? parsed : null;
}

function isTerminalDialogText(value) {
  const text = clean(value).toLowerCase();
  if (!text) return false;
  if (text.includes("dialog_unavailable")) return true;
  if (/\bhttp\s+(403|404|410)\b/.test(text)) return true;
  if ([...TERMINAL_DIALOG_CODES].some((code) => text.includes(code.toLowerCase()))) return true;
  return TERMINAL_DIALOG_TEXT_MARKERS.some((marker) => text.includes(marker));
}

function isTerminalDialogOutcome(value) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const code = normalizeCode(source.code);
  const status = normalizeStatus(source.status);

  if (source.unavailable === true) return true;
  if (/^DIALOG_UNAVAILABLE(?:_|$)/.test(code)) return true;
  if (TERMINAL_DIALOG_HTTP_STATUSES.has(status)) return true;
  if (TERMINAL_DIALOG_CODES.has(code)) return true;

  return isTerminalDialogText(`${code} ${clean(source.error)}`);
}

module.exports = {
  TERMINAL_DIALOG_CODES,
  TERMINAL_DIALOG_HTTP_STATUSES,
  TERMINAL_DIALOG_TEXT_MARKERS,
  isTerminalDialogText,
  isTerminalDialogOutcome,
};
