"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function source(rel) {
  return fs.readFileSync(path.join(__dirname, "..", rel), "utf8");
}

test("Agency soft-delete is serialized with Custom work and refuses active pipeline state", () => {
  const admin = source("routes/admin.js");
  const start = admin.indexOf('router.delete("/agencies/:id"');
  const end = admin.indexOf('router.post("/agencies/:id/restore"', start);
  assert.ok(start >= 0 && end > start, "Agency delete route must exist");
  const route = admin.slice(start, end);

  assert.match(route, /prisma\.\$transaction\s*\(\s*async\s*\(tx\)/);
  assert.match(route, /lockAgencyPipelineLifecycleExclusive\(\{\s*db:\s*tx,\s*agencyId:\s*before\.id,\s*allowDeleted:\s*true\s*\}\)/);
  assert.match(route, /assertAgencyCustomPipelineRetirable\(\{\s*db:\s*tx,\s*agencyId:\s*before\.id\s*\}\)/);
  assert.match(route, /tx\.agency\.update\([\s\S]*deletedAt[\s\S]*status:\s*"LOCKED"/);
  assert.match(route, /tx\.refreshSession\.updateMany\([\s\S]*revokedAt:\s*deletedAt/);
  assert.match(route, /isolationLevel:\s*"Serializable"/);
});

test("every production NEW Custom/provider work origin takes the Agency lifecycle fence", () => {
  const orders = source("services/custom-orders-service.js");
  const submissions = source("services/custom-content-submissions-service.js");
  const inbound = source("services/telegram-inbound-authority-service.js");
  const telegramDelivery = source("services/telegram-delivery-authority-service.js");

  const orderCreate = orders.slice(orders.indexOf("async function createCustomOrder"), orders.indexOf("async function updateCustomOrder"));
  assert.match(orderCreate, /lockAgencyPipelineLifecycle\(\{\s*db:\s*tx,\s*agencyId\s*\}\)/);
  assert.ok(orderCreate.indexOf("lockAgencyPipelineLifecycle") < orderCreate.indexOf("lockCreatorPipelineLifecycle"), "CustomOrder lock order must be Agency shared lifecycle barrier -> Creator");
  assert.ok(orderCreate.indexOf("lockCreatorPipelineLifecycle") < orderCreate.indexOf("tx.customOrder.create"), "CustomOrder create must happen after lifecycle locks");

  const manual = submissions.slice(submissions.indexOf("async function createCustomContentSubmission("), submissions.indexOf("async function createCustomContentSubmissionFromInboundEvent"));
  assert.match(manual, /lockAgencyPipelineLifecycle\(\{\s*db:\s*tx,\s*agencyId\s*\}\)/);
  assert.ok(manual.indexOf("lockAgencyPipelineLifecycle") < manual.indexOf("lockCreatorPipelineLifecycle"), "historical import lock order must start Agency shared lifecycle barrier -> Creator");
  assert.ok(manual.indexOf("lockCreatorPipelineLifecycle") < manual.indexOf("lockActiveTelegramAccountReference"), "historical import lock order must be Agency -> Creator -> TelegramAccount");
  assert.ok(manual.indexOf("lockActiveTelegramAccountReference") < manual.indexOf("tx.customContentSubmission.create"), "historical submission create must happen after lifecycle locks");

  const projected = submissions.slice(submissions.indexOf("async function createCustomContentSubmissionFromInboundEvent"), submissions.indexOf("async function assignCustomContentSubmission"));
  assert.match(projected, /lockAgencyPipelineLifecycle\(\{\s*db:\s*tx,\s*agencyId:\s*event\.agencyId\s*\}\)/);
  assert.ok(projected.indexOf("lockAgencyPipelineLifecycle") < projected.indexOf("lockCreatorPipelineLifecycle"), "provider projection lock order must be Agency shared lifecycle barrier -> Creator");
  assert.ok(projected.indexOf("lockCreatorPipelineLifecycle") < projected.indexOf("tx.customContentSubmission.create"), "provider submission create must happen after lifecycle locks");

  const ingest = inbound.slice(inbound.indexOf("async function ingestTelegramInboundEvent"), inbound.indexOf("module.exports"));
  assert.match(ingest, /hasMedia\s*===\s*true[\s\S]*lockAgencyPipelineLifecycle\(\{\s*db:\s*tx,\s*agencyId,\s*allowDeleted:\s*true\s*\}\)/);
  assert.match(ingest, /AGENCY_RETIRED_DURING_INTAKE/);

  const intentCreate = telegramDelivery.slice(telegramDelivery.indexOf("async function createOrReadIntent"), telegramDelivery.indexOf("async function findUnresolvedReminder"));
  assert.ok(intentCreate.indexOf("lockAgencyPipelineLifecycle") < intentCreate.indexOf("lockCreatorPipelineLifecycle"), "outbound intent lock order must start Agency -> Creator");
  assert.ok(intentCreate.indexOf("lockCreatorPipelineLifecycle") < intentCreate.indexOf("lockActiveTelegramAccountReference"), "outbound intent lock order must be Agency -> Creator -> TelegramAccount");
  assert.ok(intentCreate.indexOf("lockActiveTelegramAccountReference") < intentCreate.indexOf("telegramDeliveryIntent.create"), "outbound intent create must happen after all lifecycle locks");
});




test("product creator removal delegates to the canonical Agency -> Creator -> scope lifecycle authority", () => {
  const creators = source("routes/creators.js");
  const lifecycle = source("services/creator-lifecycle-authority-service.js");
  const scope = source("services/creator-access-scope-authority-service.js");
  const start = creators.indexOf('router.delete("/:id"');
  const end = creators.indexOf('router.post("/:id/complete-connection"', start);
  assert.ok(start >= 0 && end > start, "product creator removal route must exist");
  const route = creators.slice(start, end);
  assert.match(route, /retireCreatorWithinTransaction\(\{/);
  assert.doesNotMatch(route, /scanRowsById|removeCreatorFromAssignedCreators/);
  const agencyFence = lifecycle.indexOf("lockAgencyPipelineLifecycle");
  const creatorFence = lifecycle.indexOf("lockCreatorPipelineLifecycle");
  const scopeWrite = lifecycle.indexOf("await retireCreatorCurrentAccess");
  const creatorDelete = lifecycle.indexOf("creatorAccount.update");
  assert.ok(agencyFence >= 0 && creatorFence > agencyFence, "canonical lifecycle order must be Agency -> Creator");
  assert.ok(scopeWrite > creatorFence, "current scope revocation must happen under the Creator lifecycle fence");
  assert.ok(creatorDelete > scopeWrite, "Creator retirement follows current access revocation in the same transaction");
  assert.match(scope, /"accessEpoch"=m\."accessEpoch"\+1/);
  assert.match(scope, /phase2_remove_creator_from_access_scope/);
});
test("creator Telegram rebinding uses the global Agency -> Creator -> TelegramAccount lifecycle order", () => {
  const contact = source("services/creator-telegram-contact-authority-service.js");
  const start = contact.indexOf("async function updateCreatorTelegramContact");
  const end = contact.indexOf("module.exports", start);
  assert.ok(start >= 0 && end > start);
  const body = contact.slice(start, end);
  assert.ok(body.indexOf("lockAgencyPipelineLifecycle") < body.indexOf("lockCreatorPipelineLifecycle"), "rebinding must serialize with Agency retirement before Creator retirement");
  assert.ok(body.indexOf("lockCreatorPipelineLifecycle") < body.indexOf("lockActiveTelegramAccountReference"), "global provider-reference order must be Agency -> Creator -> TelegramAccount");
  assert.ok(body.indexOf("lockActiveTelegramAccountReference") < body.indexOf("creatorAccount.update"), "current Telegram reference may publish only after all lifecycle fences");
});

test("creator retirement blocks every PENDING CustomOrder, not CONTENT only", () => {
  const authority = source("services/custom-content-pipeline-authority-service.js");
  const start = authority.indexOf("async function creatorCustomPipelineBlockers");
  const end = authority.indexOf("async function agencyCustomPipelineBlockers", start);
  assert.ok(start >= 0 && end > start);
  const body = authority.slice(start, end);
  assert.match(body, /customOrder\.count\(\{\s*where:\s*\{\s*agencyId,\s*creatorId,\s*status:\s*"PENDING"\s*\}\s*\}\)/);
  assert.doesNotMatch(body, /customOrder\.count\([\s\S]*type:\s*"CONTENT"/);
});

test("PENDING CustomOrder mutation takes Agency and Creator lifecycle locks before its CAS", () => {
  const orders = source("services/custom-orders-service.js");
  const start = orders.indexOf("const applyPendingUpdate = async (tx) =>");
  const end = orders.indexOf("const row = typeof client.$transaction", start);
  assert.ok(start >= 0 && end > start);
  const body = orders.slice(start, end);
  assert.ok(body.indexOf("lockAgencyPipelineLifecycle") < body.indexOf("lockCreatorPipelineLifecycle"));
  assert.ok(body.indexOf("lockCreatorPipelineLifecycle") < body.indexOf("tx.customOrder.updateMany"));
});

test("Agency detail exposes legacy pipeline debt and UI routes retired debt through restore -> resolve -> retire", () => {
  const admin = source("routes/admin.js");
  const getStart = admin.indexOf('router.get("/agencies/:id"');
  const getEnd = admin.indexOf('router.patch("/agencies/:id"', getStart);
  assert.ok(getStart >= 0 && getEnd > getStart, "Agency detail route must exist");
  const route = admin.slice(getStart, getEnd);
  assert.match(route, /agencyCustomPipelineBlockers\(\{\s*db:\s*prisma,\s*agencyId:\s*agency\.id\s*\}\)/);
  assert.match(route, /customPipelineBlockers/);

  const ui = source("../public/admin/modules/admin-agency-detail/admin-agency-detail.js");
  assert.match(ui, /slice\.data\.customPipelineBlockers/);
  assert.match(ui, /historical pipeline debt behind a retired Agency/);
  assert.match(ui, /Restore the Agency, let the durable work converge or resolve it explicitly, then retire the Agency again/);
  assert.match(ui, /Hard delete is destructive maintenance and will intentionally remove history/);
});

test("first execution-profile pin and both mutable defaults share one commit-order fence without Creator/advisory lock inversion", () => {
  const authority = source("services/custom-content-pipeline-authority-service.js");
  const vault = source("services/custom-vault-destination-service.js");
  const settings = source("services/settings-service.js");

  const pinStart = authority.indexOf("async function ensureSubmissionExecutionProfile");
  const pinEnd = authority.indexOf("async function loadSubmissionLifecycle", pinStart);
  const pin = authority.slice(pinStart, pinEnd);
  assert.ok(pinStart >= 0 && pinEnd > pinStart);
  assert.ok(pin.indexOf("withCustomExecutionDefaultsLock") >= 0, "first profile pin must join execution-default fence");
  assert.ok(pin.indexOf("withCustomExecutionDefaultsLock") < pin.indexOf("readExecutionDefaults"), "defaults must be read only after the fence is acquired");

  const vaultStart = vault.indexOf("async function setCustomVaultDestination");
  const vaultEnd = vault.indexOf("module.exports", vaultStart);
  const vaultSetter = vault.slice(vaultStart, vaultEnd);
  assert.ok(vaultSetter.indexOf("creatorAccount.updateMany") >= 0);
  assert.ok(vaultSetter.indexOf("creatorAccount.updateMany") < vaultSetter.indexOf("lockCustomExecutionDefaults"),
    "Vault setter must take Creator row before advisory fence; advisory -> Creator would deadlock with cancellation Creator -> Submission while pinning holds Submission -> advisory");
  assert.match(vaultSetter, /\$transaction\(apply,\s*\{\s*timeout:\s*35_000\s*\}\)/);

  const settingsStart = settings.indexOf("async function updateWorkspaceSettings");
  const settingsEnd = settings.indexOf("function billingLine", settingsStart);
  const workspace = settings.slice(settingsStart, settingsEnd);
  assert.ok(workspace.indexOf("lockCustomExecutionDefaults") >= 0);
  assert.ok(workspace.indexOf("lockCustomExecutionDefaults") < workspace.indexOf("workspaceSetting.upsert"),
    "relay-recipient publication must join the same fence before its workspace write");
});

test("super-admin hard creator delete delegates to the same durable bounded lifecycle authority", () => {
  const admin = source("routes/admin.js");
  const lifecycle = source("services/creator-lifecycle-authority-service.js");
  const routeStart = admin.indexOf('router.delete("/creators/:id"');
  const routeEnd = admin.indexOf("// ════════════════════════════════════════════════════════════\n// DEVICES", routeStart);
  const route = admin.slice(routeStart, routeEnd);
  assert.match(route, /retireCreatorWithinTransaction\(\{[\s\S]*?mode: hard \? "HARD" : "SOFT"/);
  const customFence = lifecycle.indexOf("assertCreatorCustomPipelineRetirable");
  const massFence = lifecycle.indexOf("assertCreatorMassCampaignRetirable");
  const barrier = lifecycle.indexOf("creatorAccount.update");
  const publishCleanup = lifecycle.indexOf("WORK_CLASS.DESTRUCTIVE_CREATOR_CLEANUP");
  assert.ok(customFence >= 0, "canonical lifecycle must refuse active/unknown Custom external-write authority");
  assert.ok(massFence > customFence, "Custom and MASS future-effect authorities converge before destructive publication");
  assert.ok(barrier > massFence, "Creator retirement barrier follows external-effect guards");
  assert.ok(publishCleanup > barrier, "bounded cleanup work is published only after the retirement barrier");
  assert.doesNotMatch(route, /collectCreatorPhase2DestructiveScope|creatorAccount\.delete|purgeCreatorPhase2ResidualsForHardDelete/);
});

test("super-admin hard Agency delete publishes bounded destructive authority after lifecycle blockers", () => {
  const admin = source("routes/admin.js");
  const routeStart = admin.indexOf('router.delete("/agencies/:id"');
  const routeEnd = admin.indexOf('router.post("/agencies/:id/restore"', routeStart);
  const route = admin.slice(routeStart, routeEnd);
  const hardAt = route.indexOf("if (hard) {");
  const softAt = route.indexOf("const deletedAt", hardAt);
  const block = route.slice(hardAt, softAt);
  assert.match(block, /prisma\.\$transaction\s*\(\s*async\s*\(tx\)/);
  const customFence = block.indexOf("assertAgencyCustomPipelineRetirable");
  const massFence = block.indexOf("assertAgencyMassCampaignRetirable");
  const barrier = block.indexOf("tx.agency.update");
  const publishCleanup = block.indexOf("DESTRUCTIVE_AGENCY_CLEANUP");
  assert.ok(customFence >= 0 && massFence > customFence, "hard Agency delete must converge Custom then MASS authority first");
  assert.ok(barrier > massFence, "durable Agency DELETING barrier must follow blockers");
  assert.ok(publishCleanup > barrier, "bounded Agency cleanup must be published after the barrier in the same transaction");
  assert.doesNotMatch(block, /tx\.agency\.delete/);
  assert.doesNotMatch(block, /purgeAgencyPhase2ProviderLedgersForHardDelete/);
});
