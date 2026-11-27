"use strict";
const c = require("./common");
const { cleanPatch } = require("./crm-repository");

// Compute the same receipt identity as the original port without executing that
// port. Missing or expired receipts leave the outcome UNKNOWN, never rejected.
function receiptRequest(ctx, body) {
  c.check(body && typeof body === "object" && Array.isArray(body.args), "CONVERSATION_RECEIPT_REQUEST_INVALID", 400);
  c.check(body.expectedPlatformCreatorId === ctx.platformCreatorId, "DIALOG_CREATOR_IDENTITY_MISMATCH", 409);
  const a = body.args[0] || {};
  if (a.creatorId) c.check(a.creatorId === ctx.creatorId, "CONVERSATION_CREATOR_MISMATCH", 403);
  if (a.agencyId) c.check(a.agencyId === ctx.agencyId, "CONVERSATION_AGENCY_MISMATCH", 403);
  let payload;
  switch (`${body.target}.${body.method}`) {
    case "messages.commitScanPage": {
      const { dialogId, messages, statePatch, frontier, targeted } = a;
      payload = { dialogId, messages, statePatch, frontier, targeted: targeted === true };
      break;
    }
    case "messages.upsertMessages":
      c.check(Array.isArray(a) && a.length > 0, "DIALOG_BATCH_INVALID", 400);
      payload = { dialogId: a[0].dialogId, messages: a, statePatch: {} };
      break;
    case "changes.apply": {
      const change = a.change || {};
      c.check(change.creatorId === ctx.creatorId, "DIALOG_CHANGE_SCOPE_INVALID", 403);
      payload = change.source === "SERVER" || change.event?.type === "ppv_purchase_received"
        ? { operation: "changes.apply", input: a }
        : { dialogId: a.dialogId, messages: [a.message], statePatch: {}, presentFields: change.presentFields };
      break;
    }
    case "crmProfiles.updateProfile": {
      const incoming = { ...c.object(a.patch) };
      if (incoming.fanName !== undefined) { incoming.preferredName = incoming.fanName; delete incoming.fanName; }
      if (incoming.fanUsername !== undefined) { incoming.manualAlias = incoming.fanUsername; delete incoming.fanUsername; }
      delete incoming.notesManual;
      payload = { kind: "profile.patch", fanId: c.platformId(a.dialogId), patch: cleanPatch(incoming),
        baseRevision: a.baseRevision, appendNotes: a.appendNotes || [],
        ...(a.fieldBaseRevisions === undefined ? {} : { fieldBaseRevisions: a.fieldBaseRevisions }) };
      return { domain: "crm", hash: c.hash([ctx.actorId, ctx.deviceId, payload]) };
    }
    case "persona.save":
      c.check(a.profile?.creatorId === ctx.creatorId, "CRM_PERSONA_SCOPE_MISMATCH", 403);
      payload = { kind: "persona", data: c.object(a.profile), baseRevision: a.baseRevision };
      return { domain: "crm", hash: c.hash([ctx.actorId, ctx.deviceId, payload]) };
    default: throw c.fail("CONVERSATION_RECEIPT_OPERATION_INVALID", 400);
  }
  return { domain: "dialogs", hash: c.hash(payload) };
}

async function lookupReceipt(runtime, ctx, input) {
  c.bounded(input, 600000);
  c.commandId(input.commandId, { receiptReplay: true });
  const request = receiptRequest(ctx, input.body);
  await runtime.check(request.domain);
  const db = runtime.db[request.domain];
  const crm = request.domain === "crm";
  const table = crm ? "crm_command_receipt" : "dialog_archive_receipt";
  const scope = crm ? "crm_scope" : "dialog_archive_scope";
  const row = await c.one(db, `SELECT r.request_hash,r.result FROM ${table} r JOIN ${scope} s ON s.scope_id=r.scope_id
    WHERE r.scope_id=$1 AND r.command_id=$2 AND s.agency_id=$3 AND s.platform_creator_id=$4`,
    ctx.scopeId, input.commandId, ctx.agencyId, ctx.platformCreatorId);
  if (!row) return { status: "UNKNOWN", commandId: input.commandId };
  c.check(row.request_hash === request.hash, "CONVERSATION_RECEIPT_IDENTITY_CONFLICT", 409);
  if (input.body.target === "crmProfiles" && input.body.method === "updateProfile" && row.result?.rejected?.code === "CRM_EDIT_CONFLICT")
    return { status: "REJECTED", commandId: input.commandId, code: "CRM_EDIT_CONFLICT" };
  return { status: "COMMITTED", commandId: input.commandId, result: row.result };
}
module.exports = { lookupReceipt, receiptRequest };
