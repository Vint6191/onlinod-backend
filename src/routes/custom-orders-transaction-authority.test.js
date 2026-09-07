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





test("F47 dialog-composer availability is device-bound and derives publish usability from exact creator/dialog/media context", () => {
  const availability = block('router.post("/ready-deliveries/media-availability"', 'router.post("/ready-deliveries/programmatic-media-preflight"');
  assert.match(availability, /requireProductDevice\(req,\s*req\.body\?\.deviceId\)/);
  assert.match(availability, /classifyDialogComposerMediaAvailability\s*\(/);
  assert.match(availability, /creatorId:\s*req\.body\?\.creatorId/);
  assert.match(availability, /dialogId:\s*req\.body\?\.dialogId/);
  assert.match(availability, /mediaIds:\s*req\.body\?\.mediaIds/);
  assert.doesNotMatch(availability, /reviewStatus:\s*req\.body|customOrderId:\s*req\.body|submissionId:\s*req\.body/);
});

test("programmatic CUSTOM-media preflight is product-device bound and derives provenance only from actual media IDs", () => {
  const preflight = block('router.post("/ready-deliveries/programmatic-media-preflight"', 'router.post("/ready-deliveries/commit"');
  assert.match(preflight, /requireProductDevice\(req,\s*req\.body\?\.deviceId\)/);
  assert.match(preflight, /preflightProgrammaticCustomMedia\s*\(/);
  assert.match(preflight, /creatorId:\s*req\.body\?\.creatorId/);
  assert.match(preflight, /mediaIds:\s*req\.body\?\.mediaIds/);
  assert.doesNotMatch(preflight, /customOrderId:\s*req\.body|dialogId:\s*req\.body/);
});

test("manual CUSTOM physical-send commit is device/access-bound and mints server-visible Audit17 authority", () => {
  const commit = block('router.post("/ready-deliveries/commit"', 'router.post("/ready-deliveries/preflight"');
  assert.match(commit, /requireProductDevice\(req,\s*req\.body\?\.deviceId\)/);
  assert.match(commit, /currentAccessEpoch\(req\)/);
  assert.match(commit, /prepareCustomManualDeliveryCommit\s*\(/);
  assert.match(commit, /networkRequestId:\s*req\.body\?\.networkRequestId/);
  assert.doesNotMatch(commit, /customOrderId:\s*req\.body/);
});



test("manual CUSTOM has no approximate readback-match settlement routes", () => {
  assert.doesNotMatch(source, /ready-deliveries\/reconciliation-work/);
  assert.doesNotMatch(source, /ready-deliveries\/reconciliation\/:writeId\/matched/);
  assert.doesNotMatch(source, /resolveCustomManualDeliveryReconciliationMatched|listCustomManualDeliveryReconciliationWork/);
});

test("manual CUSTOM physical-send preflight is device-bound and derives authority from actual media, not a client order id", () => {
  const preflight = block('router.post("/ready-deliveries/preflight"', 'router.get("/ready-deliveries"');
  assert.match(preflight, /requireProductDevice\(req,\s*req\.body\?\.deviceId\)/);
  assert.match(preflight, /preflightCustomManualSend\s*\(/);
  assert.match(preflight, /creatorId:\s*req\.body\?\.creatorId/);
  assert.match(preflight, /dialogId:\s*req\.body\?\.dialogId/);
  assert.match(preflight, /mediaIds:\s*req\.body\?\.mediaIds/);
  assert.match(preflight, /commitAuthorityVersion/);
  assert.match(preflight, /CUSTOM_MANUAL_V1/);
  assert.match(preflight, /CUSTOM_DELIVERY_CLIENT_UPGRADE_REQUIRED/);
  assert.doesNotMatch(preflight, /customOrderId:\s*req\.body/);
});
test("direct client fan-delivery confirmation is retired; only durable MESSAGE_SEND_CONFIRMED projection remains", () => {
  const direct = block('router.post("/ready-deliveries/:customOrderId/confirm-send"', 'router.get("/review-queue"');
  assert.match(direct, /status\(410\)/);
  assert.match(direct, /CUSTOM_DELIVERY_DIRECT_CONFIRM_RETIRED/);
  assert.match(direct, /MESSAGE_SEND_CONFIRMED/);
  assert.doesNotMatch(direct, /recordCustomDeliverySend\s*\(/);
});

test("REFERENCE artifact recovery routes preserve the same server slot behind product-device authority", () => {
  const replace = block('router.post("/telegram-deliveries/:intentId/reference-replace"', 'router.post("/telegram-deliveries/:intentId/reference-cancel"');
  assert.match(replace, /requireProductDevice\(req,\s*req\.body\?\.deviceId\)/);
  assert.match(replace, /replaceTelegramReferencePrecommit\s*\(/);
  assert.match(replace, /intentId:\s*req\.params\.intentId/);
  assert.match(replace, /clientIntentId:\s*req\.body\?\.clientIntentId/);
  assert.match(replace, /reference:\s*req\.body\?\.reference/);

  const cancel = block('router.post("/telegram-deliveries/:intentId/reference-cancel"', 'router.post("/telegram-deliveries/:intentId/reconcile"');
  assert.match(cancel, /requireProductDevice\(req,\s*req\.body\?\.deviceId\)/);
  assert.match(cancel, /cancelTelegramReferencePrecommit\s*\(/);
  assert.match(cancel, /intentId:\s*req\.params\.intentId/);
  assert.match(cancel, /reason:\s*req\.body\?\.reason/);
});

test("Telegram inbound route hands the durable provider observation only to inbound authority", () => {
  const inbound = block('router.post("/telegram-inbound"', 'router.post("/telegram-deliveries/work"');
  assert.match(inbound, /requireProductDevice\(req,\s*req\.body\?\.deviceId\)/);
  assert.match(inbound, /ingestTelegramInboundEvent\s*\(/);
  assert.doesNotMatch(inbound, /createCustomContentSubmission/);
});

test("Vault settlement receipt is device-bound and Content Library finalize cannot accept client settlement assertions", () => {
  const receipt = block('router.post("/submissions/:submissionId/vault-settlement/confirm"', 'router.post("/submissions/:submissionId/content-library-finalize"');
  assert.match(receipt, /requireProductDevice\(req,\s*req\.body\?\.deviceId\)/);
  assert.match(receipt, /confirmCustomContentSubmissionVaultSettlement\s*\(/);
  assert.match(receipt, /folderId:\s*req\.body\?\.folderId/);
  assert.match(receipt, /profileRevision:\s*req\.body\?\.profileRevision/);
  assert.match(receipt, /mediaIds:\s*req\.body\?\.mediaIds/);

  const finalize = block('router.post("/submissions/:submissionId/content-library-finalize"', 'router.patch("/submissions/:submissionId"');
  assert.match(finalize, /finalizeCustomContentSubmissionLibrary\s*\(/);
  assert.doesNotMatch(finalize, /folderId:\s*req\.body|mediaIds:\s*req\.body|settled:\s*req\.body/);
});
