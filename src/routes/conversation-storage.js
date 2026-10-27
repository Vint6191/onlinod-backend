"use strict";
const express = require("express");
const { conversationContext } = require("../services/conversation-storage/access");
const { runtime, READS } = require("../services/conversation-storage/runtime");
const c = require("../services/conversation-storage/common");
const { configuration } = require("../services/conversation-storage/databases");
const { canUsePermission } = require("../services/team-access-control");
const router = express.Router();
let active = 0,
  retainedBytes = 0;
const RECEIPT_OPERATIONS = new Set([
  "messages.commitScanPage",
  "messages.upsertMessages",
  "changes.apply",
  "crmProfiles.updateProfile",
  "persona.save",
]);
router.get("/configuration", (_req, res) => {
  try {
    configuration();
    res.json({ ok: true, mode: "server", dialogQuotaBytes: 200000000 });
  } catch (error) {
    res.status(error.status || 503).json({ ok: false, code: error.code || "CONVERSATION_NOT_CONFIGURED" });
  }
});
router.post("/creators/:creatorId/call", async (req, res) => {
  const started = Date.now();
  let admittedBytes = 0;
  try {
    const bytes = Buffer.byteLength(c.bounded(req.body, 600000));
    if (active >= 24 || retainedBytes + bytes > 8388608) {
      res.set("Retry-After", "2");
      throw c.fail("CONVERSATION_BACKPRESSURE", 429);
    }
    active++;
    retainedBytes += bytes;
    admittedBytes = bytes;
    const { target, method, args, commandId } = req.body || {};
    c.text(target, 40);
    c.text(method, 80);
    const ctx = await conversationContext(req, req.params.creatorId);
    if (target === "crmProfiles" && ["getPanelSnapshot", "updateProfile"].includes(method))
      ctx.canViewMoney = await canUsePermission({ member: req.auth.membership, key: "money.view_earnings" });
    c.check(Array.isArray(args), "CONVERSATION_ARGUMENTS_INVALID", 400);
    // The path and the canonical membership own scope. Nested client fields may
    // narrow it, never change it; IDs in bodies are not authority.
    const first = args[0];
    const supplied = first?.scope || first?.input?.scope || first;
    if (supplied?.creatorId) c.check(supplied.creatorId === ctx.creatorId, "CONVERSATION_CREATOR_MISMATCH", 403);
    if (supplied?.agencyId) c.check(supplied.agencyId === ctx.agencyId, "CONVERSATION_AGENCY_MISMATCH", 403);
    if (!READS.has(method)) c.commandId(commandId, { receiptReplay: RECEIPT_OPERATIONS.has(`${target}.${method}`) });
    const value = await runtime().call(ctx, target, method, args, commandId);
    if (Date.now() - started > 1500)
      console.warn(
        JSON.stringify({
          message: "slow conversation storage operation",
          target,
          method,
          creatorId: ctx.creatorId,
          durationMs: Date.now() - started,
        })
      );
    res.json({ ok: true, value: c.jsonResult(value ?? null) });
  } catch (error) {
    const code = error.code || "CONVERSATION_STORAGE_FAILED",
      status = Number(error.status) || 503;
    console.warn(
      JSON.stringify({
        message: "conversation storage operation failed",
        target: req.body?.target,
        method: req.body?.method,
        creatorId: req.params.creatorId,
        code,
        sqlState: error.meta?.code || null,
        durationMs: Date.now() - started,
      })
    );
    res.status(status >= 400 && status <= 599 ? status : 503).json({ ok: false, code, error: code });
  } finally {
    if (admittedBytes) {
      active--;
      retainedBytes -= admittedBytes;
    }
  }
});
module.exports = router;
