"use strict";
const c = require("./common");
class DialogChanges {
  constructor(dialogs, core) {
    this.dialogs = dialogs;
    this.db = dialogs.db;
    this.core = core;
  }
  async purchase(ctx, input, command, receiptInput = { operation: "purchase", input }) {
    const old = await c.one(
      this.db,
      "SELECT * FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 AND message_id=$3",
      ctx.scopeId,
      input.dialogId,
      input.messageId
    );
    if (!old) return { found: false, changed: false, needsProviderValidation: false };
    const result = await this.dialogs.commitScanPage(
      ctx,
      {
        dialogId: input.dialogId,
        messages: [
          { ...old.data, opened: old.provider_opened ? 1 : 0, creatorId: ctx.creatorId, dialogId: input.dialogId },
        ],
        statePatch: {},
        purchaseProof: input,
      },
      command,
      receiptInput
    );
    return { found: true, changed: result.summary.updated > 0, needsProviderValidation: false };
  }
  async apply(ctx, input, command) {
    const change = input.change;
    c.check(change?.creatorId === ctx.creatorId, "DIALOG_CHANGE_SCOPE_INVALID", 403);
    const event = c.object(change.event),
      server = change.source === "SERVER";
    let result;
    if (server || event.type === "ppv_purchase_received") {
      let payload = server ? c.object(event.payload) : event,
        revision = 0,
        opened = true;
      if (server) {
        const authoritative = await c.one(
          this.core,
          'SELECT * FROM "CreatorEntityCurrent" WHERE "agencyId"=$1 AND "creatorId"=$2 AND "entityType"=\'MESSAGE_PURCHASE\' AND "entityId"=$3',
          ctx.agencyId,
          ctx.creatorId,
          event.entityId
        );
        c.check(authoritative, "DIALOG_CANONICAL_PROOF_UNAVAILABLE", 409);
        payload = authoritative.payload;
        revision = String(authoritative.revision);
        opened = !authoritative.tombstone && payload.opened === true;
      }
      const messageId = c.platformId(String(payload.messageId || payload.purchaseMessageId || ""));
      c.check(!payload.dialogId || payload.dialogId === input.dialogId, "DIALOG_PURCHASE_SCOPE_INVALID", 403);
      result = await this.purchase(
        ctx,
        {
          dialogId: input.dialogId,
          messageId,
          kind: server ? "canonical" : "provider",
          opened,
          revision,
          observedAt: c.iso(change.receivedAt),
        },
        command,
        { operation: "changes.apply", input }
      );
      if (!result.found)
        return {
          status: "WAITING",
          dependency: `message:${ctx.creatorId}:${input.dialogId}:${messageId}`,
          reason: "message_not_collected",
        };
    } else {
      c.check(input.message && Array.isArray(change.presentFields), "DIALOG_CHANGE_MESSAGE_REQUIRED", 400);
      const commit = await this.dialogs.commitScanPage(
        ctx,
        { dialogId: input.dialogId, messages: [input.message], statePatch: {}, presentFields: change.presentFields },
        command
      );
      result = { changed: commit.summary.inserted + commit.summary.updated > 0 };
    }
    return { status: result.changed ? "APPLIED" : "ALREADY_APPLIED", receiptId: change.id };
  }
  async due(ctx, input) {
    return (
      await c.rows(
        this.db,
        "SELECT * FROM dialog_archive_debt WHERE scope_id=$1 AND desired>completed AND status<>'STOPPED' AND next_at<=now() ORDER BY next_at,dialog_id,owner LIMIT $2",
        ctx.scopeId,
        Math.min(32, input.limit || 16)
      )
    ).map((r) => ({
      creatorId: ctx.creatorId,
      dialogId: r.dialog_id,
      owner: r.owner,
      version: Number(r.desired),
      attempts: r.attempts,
    }));
  }
  async reserve(ctx, input) {
    return Boolean(
      await c.exec(
        this.db,
        "UPDATE dialog_archive_debt SET status='RUNNING',attempts=attempts+1,next_at=now()+interval '5 minutes',lease_device=$6 WHERE scope_id=$1 AND dialog_id=$2 AND owner=$3 AND desired=$4 AND attempts=$5 AND attempts<12 AND next_at<=now() AND desired>completed AND status<>'STOPPED'",
        ctx.scopeId,
        input.dialogId,
        input.owner,
        input.version,
        input.attempts,
        ctx.deviceId
      )
    );
  }
  async complete(ctx, input) {
    await c.exec(
      this.db,
      "UPDATE dialog_archive_debt SET completed=GREATEST(completed,$4),status=CASE WHEN desired<=$4 THEN 'HANDED_OFF' ELSE status END,receipt_id=$5 WHERE scope_id=$1 AND dialog_id=$2 AND owner=$3 AND lease_device=$6 AND desired>completed AND desired>=$4 AND status='RUNNING' AND next_at>now()",
      ctx.scopeId,
      input.dialogId,
      input.owner,
      input.version,
      String(input.receiptId || "").slice(0, 240),
      ctx.deviceId
    );
  }
  async settle(ctx, input, kind) {
    const wait = kind === "wait";
    await c.exec(
      this.db,
      `UPDATE dialog_archive_debt SET status=CASE WHEN $7='stop' OR attempts>=12 THEN 'STOPPED' ELSE 'WAITING' END,
    attempts=GREATEST(0,attempts-$8),next_at=now()+interval '30 seconds',reason=$5 WHERE scope_id=$1 AND dialog_id=$2 AND owner=$3 AND desired=$4 AND lease_device=$6 AND status='RUNNING'`,
      ctx.scopeId,
      input.dialogId,
      input.owner,
      input.version,
      String(input.reason || "").slice(0, 300),
      ctx.deviceId,
      kind,
      wait ? 1 : 0
    );
  }
}
module.exports = { DialogChanges };
