"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "custom-orders.js"), "utf8");

function block(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.notEqual(start, -1, `missing route marker ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(end, -1, `missing end marker ${endMarker}`);
  return source.slice(start, end);
}

test("raw Telegram submission IDs are not an ordinary creator-scoped mutation authority", () => {
  const raw = block('router.post("/submissions",', 'router.post("/submissions/manual-import"');
  assert.match(raw, /status\(410\)/);
  assert.match(raw, /CUSTOM_SUBMISSION_RAW_INGRESS_RETIRED/);
  assert.doesNotMatch(raw, /createCustomContentSubmission\s*\(/);

  const manual = block('router.post("/submissions/manual-import"', 'router.post("/submissions/upload-work"');
  assert.match(manual, /requireProductPermission\(req,\s*"content\.review_customs"/);
  assert.match(manual, /manualImportReason:\s*req\.body\?\.reason\s*\|\|\s*req\.body\?\.manualImportReason/);
});


test("relay reserve forwards the exact claimed Telegram source identity into the server authority boundary", () => {
  const relay = block('router.post("/submissions/:submissionId/relay-write/reserve"', 'router.post("/submissions/:submissionId/relay-write/close-unresolved"');
  assert.match(relay, /expectedIndex:\s*req\.body\?\.expectedIndex/);
  assert.match(relay, /expectedTelegramMessageId:\s*req\.body\?\.telegramMessageId/);
});

test("generic submission reassignment cannot bypass the dedicated review-authorized workflow", () => {
  const generic = block('router.patch("/submissions/:submissionId"', 'router.get("/ready-deliveries"');
  assert.match(generic, /status\(410\)/);
  assert.match(generic, /CUSTOM_SUBMISSION_GENERIC_ASSIGN_RETIRED/);
  assert.doesNotMatch(generic, /assignCustomContentSubmission\s*\(/);
});

test("client-supplied OF mediaId is rejected and media projection calls the server proof projector", () => {
  const media = block('router.post("/submissions/:submissionId/media-commit"', 'router.post("/submissions/:submissionId/content-library-finalize"');
  assert.match(media, /req\.body\?\.mediaId\s*!==\s*undefined/);
  assert.match(media, /status\(410\)/);
  assert.match(media, /CUSTOM_SUBMISSION_MEDIA_ASSERTION_RETIRED/);
  assert.match(media, /commitCustomContentSubmissionMedia\s*\(/);
  assert.doesNotMatch(media, /mediaId:\s*req\.body/);
});

test("direct client fan-delivery confirmation is retired; only durable MESSAGE_SEND_CONFIRMED projection remains", () => {
  const direct = block('router.post("/ready-deliveries/:customOrderId/confirm-send"', 'router.get("/review-queue"');
  assert.match(direct, /status\(410\)/);
  assert.match(direct, /CUSTOM_DELIVERY_DIRECT_CONFIRM_RETIRED/);
  assert.match(direct, /MESSAGE_SEND_CONFIRMED/);
  assert.doesNotMatch(direct, /recordCustomDeliverySend\s*\(/);
});
