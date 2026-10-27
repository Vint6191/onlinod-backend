"use strict";
const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const path = require("node:path");
const runtime = process.env.ONLINOD_SQL_PROOF_RUNTIME;
const nativeUrls = [process.env.ONLINOD_DIALOGS_TEST_DATABASE_URL, process.env.ONLINOD_CRM_TEST_DATABASE_URL];
const PGlite = nativeUrls[0]
  ? null
  : (runtime ? createRequire(path.join(runtime, "package.json")) : require)("@electric-sql/pglite").PGlite;
const { install } = require("../database/install-conversation-stores");
const c = require("../../src/services/conversation-storage/common");
const { DialogRepository } = require("../../src/services/conversation-storage/dialog-repository");
const { CrmRepository } = require("../../src/services/conversation-storage/crm-repository");
const { HistoryRelay } = require("../../src/services/conversation-storage/history-relay");
const { CrmAnalysisService } = require("../../src/services/conversation-storage/crm-analysis-service");
const { DialogReadModels } = require("../../src/services/conversation-storage/dialog-read-models");
const { DialogChanges } = require("../../src/services/conversation-storage/dialog-changes");
function adapter(pg) {
  return {
    $queryRawUnsafe: async (sql, ...p) => (await pg.query(sql, p)).rows,
    $executeRawUnsafe: async (sql, ...p) => (await pg.query(sql, p)).affectedRows,
    $transaction: async (fn) => pg.transaction((tx) => fn(adapter(tx))),
  };
}
async function fixture() {
  let pg, crmPg, db, crmDb;
  if (nativeUrls[0]) {
    for (const raw of nativeUrls) {
      const url = new URL(raw);
      assert.ok(
        ["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname.startsWith("/onlinod_test_"),
        "Native proof accepts only local fixture databases"
      );
    }
    assert.notEqual(nativeUrls[0], nativeUrls[1]);
    const { PrismaClient } = require("@prisma/client");
    db = new PrismaClient({ datasources: { db: { url: nativeUrls[0] } } });
    crmDb = new PrismaClient({ datasources: { db: { url: nativeUrls[1] } } });
    pg = { close: () => db.$disconnect() };
    crmPg = { close: () => crmDb.$disconnect() };
  } else {
    pg = new PGlite();
    crmPg = new PGlite();
    db = adapter(pg);
    crmDb = adapter(crmPg);
  }
  await install(db, "dialogs");
  await install(crmDb, "crm");
  await install(db, "dialogs");
  await install(crmDb, "crm");
  const ctx = {
    agencyId: "agency-a",
    creatorId: "internal-model",
    platformCreatorId: "1234",
    deviceId: "device-a",
    actorId: "member-a",
  };
  ctx.scopeId = c.scopeId(ctx.agencyId, ctx.platformCreatorId);
  const dialogs = new DialogRepository(db),
    crm = new CrmRepository(crmDb, dialogs),
    relay = new HistoryRelay(dialogs, crm);
  await dialogs.scope(ctx);
  await db.$executeRawUnsafe(
    "UPDATE dialog_archive_scope SET collection_from='2026-01-01' WHERE scope_id=$1",
    ctx.scopeId
  );
  return {
    pg,
    crmPg,
    db,
    crmDb,
    ctx,
    dialogs,
    crm,
    relay,
    close: async () => {
      await pg.close();
      await crmPg.close();
    },
  };
}
function message(ctx, id = "101", text = "A normal conversation") {
  return {
    creatorId: ctx.creatorId,
    dialogId: "5678",
    platformCreatorId: ctx.platformCreatorId,
    platformFanId: "5678",
    platformAuthorId: "5678",
    messageId: id,
    sender: "user",
    text,
    mediaIds: [],
    price: 0,
    opened: 0,
    createdAt: "2026-10-25T12:00:00.000Z",
    changedAt: null,
    source: "delta_scan",
  };
}
async function main() {
  const f = await fixture();
  const { dialogs, crm, relay, ctx, db, crmDb } = f;
  try {
    const command = c.newCommandId(),
      page = {
        dialogId: "5678",
        messages: [message(ctx)],
        statePatch: { fullScanDone: true, scanHasMore: false },
        frontier: { episode: "proof", cursor: null, nextCursor: null, knownPage: 0 },
      };
    const first = await dialogs.commitScanPage(ctx, page, command),
      repeat = await dialogs.commitScanPage(ctx, page, command);
    assert.deepEqual(repeat, first);
    assert.equal(first.summary.inserted, 1);
    assert.equal(first.state.collectionComplete, true);
    assert.equal(first.state.fullScanDone, false);
    assert.equal((await dialogs.getMessages(ctx, { dialogId: "5678" }))[0].platformCreatorId, "1234");
    await assert.rejects(
      () =>
        dialogs.commitScanPage(
          ctx,
          { ...page, messages: [{ ...message(ctx), platformCreatorId: "9999" }] },
          c.newCommandId()
        ),
      { code: "DIALOG_CREATOR_IDENTITY_MISMATCH" }
    );
    await assert.rejects(
      () =>
        dialogs.commitScanPage(
          ctx,
          { ...page, messages: [{ ...message(ctx), platformFanId: "1111", platformAuthorId: "1111" }] },
          c.newCommandId()
        ),
      { code: "DIALOG_FAN_IDENTITY_MISMATCH" }
    );
    const other = { ...ctx, agencyId: "agency-b" };
    other.scopeId = c.scopeId(other.agencyId, other.platformCreatorId);
    assert.equal((await dialogs.getMessages(other, { dialogId: "5678" })).length, 0);
    const episode = "2026-10-25T00:00:00Z";
    const storageEpoch = (await dialogs.getStatus(ctx)).epoch;
    await dialogs.markState(ctx, {
      dialogId: "4444",
      storageEpoch,
      expectedEpisode: null,
      patch: { scanMode: "full", scanStartedAt: episode, scanHasMore: true },
    });
    await assert.rejects(
      () =>
        dialogs.markState(
          { ...ctx, deviceId: "second-device" },
          {
            dialogId: "4444",
            storageEpoch,
            expectedEpisode: episode,
            patch: { scanMode: "full", scanStartedAt: "new" },
          }
        ),
      { code: "DIALOG_COLLECTOR_BUSY" }
    );
    await dialogs.commitScanPage(
      ctx,
      {
        dialogId: "4444",
        messages: [],
        statePatch: { scanHasMore: true },
        frontier: { episode, cursor: null, nextCursor: "500", knownPage: 0 },
      },
      c.newCommandId()
    );
    await assert.rejects(
      () =>
        dialogs.commitScanPage(
          ctx,
          {
            dialogId: "4444",
            messages: [],
            statePatch: { scanHasMore: false },
            frontier: { episode, cursor: "skipped", nextCursor: null, knownPage: 0 },
          },
          c.newCommandId()
        ),
      { code: "DIALOG_SCAN_FRONTIER_CHANGED" }
    );
    await db.$executeRawUnsafe(
      "UPDATE dialog_archive_thread SET collector_until=now()-interval '1 second' WHERE scope_id=$1 AND dialog_id='4444'",
      ctx.scopeId
    );
    await dialogs.markState(
      { ...ctx, deviceId: "second-device" },
      {
        dialogId: "4444",
        storageEpoch,
        expectedEpisode: episode,
        patch: { scanMode: "full", scanStartedAt: "replacement" },
      }
    );
    await assert.rejects(
      () =>
        dialogs.commitScanPage(
          ctx,
          {
            dialogId: "4444",
            messages: [],
            statePatch: {},
            frontier: { episode, cursor: "500", nextCursor: null, knownPage: 0 },
          },
          c.newCommandId()
        ),
      { code: "DIALOG_COLLECTOR_LEASE_LOST" }
    );
    // Both terminal and error writes are fenced after cross-device takeover.
    for (const patch of [{ scanMode: null, scanHasMore: false }, { scanError: "stale failure" }]) {
      await assert.rejects(
        () => dialogs.markState(ctx, { dialogId: "4444", storageEpoch, expectedEpisode: episode, patch }),
        { code: "DIALOG_COLLECTOR_LEASE_LOST" }
      );
    }
    const replacementCtx = { ...ctx, deviceId: "second-device" };
    await assert.rejects(
      () =>
        dialogs.markState(replacementCtx, {
          dialogId: "4444",
          storageEpoch,
          expectedEpisode: episode,
          patch: { scanMode: "full", scanStartedAt: episode },
        }),
      { code: "DIALOG_COLLECTOR_LEASE_LOST" }
    );
    await assert.rejects(
      () =>
        dialogs.markState(replacementCtx, {
          dialogId: "4444",
          storageEpoch: "restored-epoch",
          expectedEpisode: "replacement",
          patch: { scanError: "stale restore" },
        }),
      { code: "HISTORY_INPUT_CONFLICT" }
    );
    assert.equal((await dialogs.getState(ctx, { dialogId: "4444" })).scanStartedAt, "replacement");
    assert.equal((await dialogs.getState(ctx, { dialogId: "4444" })).scanError, null);
    await dialogs.markState(replacementCtx, {
      dialogId: "4444",
      storageEpoch,
      expectedEpisode: "replacement",
      patch: { scanMode: null, scanHasMore: false },
    });
    // Terminal completion releases immediately; no needless two-minute delay.
    await dialogs.markState(ctx, {
      dialogId: "4444",
      storageEpoch,
      expectedEpisode: "replacement",
      patch: { scanMode: "delta", scanStartedAt: "next", scanHasMore: true },
    });
    await assert.rejects(
      () =>
        crm.updateProfile(
          ctx,
          { dialogId: "7777", baseRevision: 999999, patch: { preferredName: "Future revision bypass" } },
          c.newCommandId()
        ),
      { code: "CRM_EDIT_CONFLICT" }
    );
    await Promise.all(
      ["concurrent A", "concurrent B"].map((note) =>
        crm.updateProfile(ctx, { dialogId: "7777", baseRevision: 0, patch: {}, appendNotes: [note] }, c.newCommandId())
      )
    );
    assert.deepEqual((await crm.getProfile(ctx, "7777")).notesManual.sort(), ["concurrent A", "concurrent B"]);
    // Receipt replay after 24h must return the original commit, while an old
    // unknown command must never execute. This also covers an ACK lost offline.
    const receiptNote = { dialogId: "8888", baseRevision: 0, patch: {}, appendNotes: ["Exactly one note"] };
    const receiptCommand = c.newCommandId();
    await crm.updateProfile(ctx, receiptNote, receiptCommand);
    const realNow = Date.now;
    Date.now = () => realNow() + 25 * 3600000;
    try {
      await crm.updateProfile(ctx, receiptNote, receiptCommand);
      assert.deepEqual((await crm.getProfile(ctx, "8888")).notesManual, ["Exactly one note"]);
      assert.deepEqual(await dialogs.commitScanPage(ctx, page, command), first);
      const unknown = `cs1:${realNow()}:${c.randomUUID()}`;
      await assert.rejects(() => crm.updateProfile(ctx, receiptNote, unknown), {
        code: "CONVERSATION_COMMAND_EXPIRED",
      });
      await assert.rejects(() => dialogs.commitScanPage(ctx, page, unknown), { code: "CONVERSATION_COMMAND_EXPIRED" });
    } finally {
      Date.now = realNow;
    }
    const changed = { ...message(ctx, "101", "Updated"), changedAt: "2026-10-26T00:00:00.000Z" };
    assert.deepEqual(
      await dialogs.findExistingMessageIds(ctx, {
        dialogId: "5678",
        messageIds: ["101"],
        unchangedMessages: [changed],
      }),
      []
    );
    const before = await dialogs.beginInput(ctx, { dialogId: "5678" });
    await dialogs.commitScanPage(ctx, { dialogId: "5678", messages: [changed], statePatch: {} }, c.newCommandId());
    await assert.rejects(() => dialogs.validateInput(ctx, before), { code: "HISTORY_INPUT_CONFLICT" });
    await relay.scope(ctx);
    await relay.scope(ctx);
    assert.equal(
      Number(
        (
          await c.one(
            crmDb,
            "SELECT history_revision FROM crm_profile WHERE scope_id=$1 AND fan_id=$2",
            ctx.scopeId,
            "5678"
          )
        ).history_revision
      ),
      2
    );
    await crm.updateProfile(
      ctx,
      { dialogId: "5678", baseRevision: 0, patch: { preferredName: "Manual name" }, appendNotes: ["First note"] },
      c.newCommandId()
    );
    await crm.updateProfile(
      ctx,
      { dialogId: "5678", baseRevision: 0, patch: { manualAlias: "Private alias" }, appendNotes: ["Second note"] },
      c.newCommandId()
    );
    await assert.rejects(
      () =>
        crm.updateProfile(
          ctx,
          { dialogId: "5678", baseRevision: 0, patch: { preferredName: "Lost edit" } },
          c.newCommandId()
        ),
      { code: "CRM_EDIT_CONFLICT" }
    );
    assert.deepEqual((await crm.getProfile(ctx, "5678")).notesManual, ["First note", "Second note"]);
    await c.transaction(crmDb, (tx) =>
      crm.applyAiPatch(ctx, "5678", { preferredName: "AI overwrites", analysisUpdatedAt: new Date().toISOString() }, tx)
    );
    assert.equal((await crm.getProfile(ctx, "5678")).preferredName, "Manual name");
    const config = {
      provider: "ollama",
      model: "test-model",
      configRevision: "fixture",
      promptVersion: "crm-paged-v3",
      schemaVersion: "crm-final-v1",
    };
    const scope = { agencyId: ctx.agencyId, creatorId: ctx.creatorId, dialogId: "5678" },
      analysis = new CrmAnalysisService(crm, dialogs, relay);
    const identity = Object.fromEntries(
      [
        "name",
        "preferred_address",
        "age",
        "country",
        "city",
        "location",
        "native_language",
        "chat_language",
        "timezone",
        "profession",
      ].map((key) => [key, ""])
    );
    const common = {
      sexual_dynamic: {
        fan_role: "unknown",
        preferred_creator_role: "unknown",
        control_preference: "unknown",
        notes: "",
      },
      fetishes: [],
      content_preferences: [],
      turn_on_triggers: [],
      requested_content: [],
      boundaries: [],
      negations: [],
      evidence_notes: [],
    };
    const sales = { budget_min: null, budget_max: null, price_resistance: "" };
    const chunk = { ...common, identity_facts: identity, sales_facts: sales, behavior: [] };
    const final = {
      ...common,
      identity,
      sales,
      strategy: { recommended_tone: "", sales_trigger: "", do_not_do: [], summary: "Collected conversation." },
      notes_auto: [],
      reply_suggestions: [],
    };
    await analysis.request(ctx, scope, { commandId: c.newCommandId(), config });
    const claim = c.newCommandId(),
      run = await analysis.claim(ctx, scope, claim);
    assert.ok(run);
    assert.deepEqual(await analysis.claim(ctx, scope, claim), run);
    const pageProof = await analysis.readNextPage(ctx, run);
    assert.equal(pageProof.items[0].text, "Updated");
    const checkpoint = { pageNumber: pageProof.proof.pageNumber, pageHash: pageProof.proof.hash, summary: chunk };
    await analysis.checkpoint(ctx, run, checkpoint);
    await analysis.checkpoint(ctx, run, checkpoint);
    await assert.rejects(() => analysis.checkpoint(ctx, run, { ...checkpoint, pageHash: "different" }), {
      code: "ANALYSIS_CHECKPOINT_CONFLICT",
    });
    await analysis.saveReduction(ctx, run, { throughPage: 0, summary: chunk });
    await analysis.saveFinal(ctx, run, final);
    await dialogs.commitScanPage(
      ctx,
      {
        dialogId: "5678",
        messages: [{ ...message(ctx, "150", "A new message during inference"), createdAt: "2026-10-25T12:01:00.000Z" }],
        statePatch: {},
      },
      c.newCommandId()
    );
    await relay.scope(ctx);
    assert.equal(
      (await analysis.work(ctx, scope)).generation,
      run.generation,
      "append must not supersede a valid captured prefix"
    );
    const completion = c.newCommandId(),
      accepted = await analysis.complete(ctx, run, completion, final);
    assert.equal(accepted.status, "accepted");
    assert.equal((await analysis.work(ctx, scope)).state, "READY", "the appended suffix remains queued");
    assert.deepEqual(await analysis.complete(ctx, run, completion, final), accepted);
    await assert.rejects(() => analysis.complete(ctx, run, completion, { ...final, notes_auto: ["Different"] }), {
      code: "CRM_COMMAND_CONFLICT",
    });
    assert.equal((await crm.getProfile(ctx, "5678")).preferredName, "Manual name");
    await analysis.request(ctx, scope, { commandId: c.newCommandId(), config, force: true });
    const oldRun = await analysis.claim(ctx, scope, c.newCommandId());
    await crmDb.$executeRawUnsafe(
      "UPDATE crm_analysis_run SET lease_until=now()-interval '1 second' WHERE run_id=$1",
      oldRun.runId
    );
    const deviceB = { ...ctx, deviceId: "device-b" };
    const resumed = await analysis.claim(deviceB, scope, c.newCommandId());
    assert.equal(resumed.runId, oldRun.runId);
    assert.notEqual(resumed.leaseToken, oldRun.leaseToken);
    await assert.rejects(() => analysis.renew(ctx, oldRun), { code: "ANALYSIS_LEASE_NOT_CURRENT" });
    // Replies may be the first operation after a separate CRM restore.
    await dialogs.commitScanPage(
      ctx,
      {
        dialogId: "9876",
        messages: [{ ...message(ctx, "601"), dialogId: "9876", platformFanId: "9876", platformAuthorId: "9876" }],
        statePatch: {},
      },
      c.newCommandId()
    );
    const replyScope = { ...scope, dialogId: "9876" },
      replyA = c.newCommandId(),
      replyB = c.newCommandId();
    const replyInput = await analysis.beginReplies(ctx, replyScope, replyA);
    assert.equal(replyInput.profile.revision, 0);
    assert.deepEqual(await analysis.beginReplies(ctx, replyScope, replyA), replyInput);
    await analysis.beginReplies(ctx, replyScope, replyB);
    await assert.rejects(() => analysis.beginReplies(ctx, replyScope, replyA), { code: "CRM_REPLY_SUPERSEDED" });
    const replies = {
      reply_suggestions: [{ text: "Thanks for sharing that.", tone: "friendly", intent: "rapport", confidence: 0.8 }],
    };
    await analysis.completeReplies(ctx, replyScope, { token: replyB, raw: replies });
    await analysis.completeReplies(ctx, replyScope, { token: replyB, raw: replies });
    await assert.rejects(
      () =>
        analysis.completeReplies(ctx, replyScope, {
          token: replyB,
          raw: { reply_suggestions: [{ ...replies.reply_suggestions[0], text: "A different reply." }] },
        }),
      { code: "CRM_REPLY_RESULT_CONFLICT" }
    );
    const models = new DialogReadModels(dialogs),
      purchase = new DialogChanges(dialogs, {});
    const paid = {
      ...message(ctx, "201"),
      sender: "creator",
      platformAuthorId: ctx.platformCreatorId,
      price: 10,
      mediaIds: ["901", "902"],
      createdAt: "2026-10-25T13:00:00.000Z",
    };
    await dialogs.commitScanPage(ctx, { dialogId: "5678", messages: [paid], statePatch: {} }, c.newCommandId());
    assert.equal((await models.listMediaUsageFactPage(ctx, { dialogId: "5678" })).facts.length, 2);
    const purchaseInput = {
      dialogId: "5678",
      messageId: "201",
      kind: "canonical",
      revision: "3",
      opened: true,
      observedAt: new Date().toISOString(),
    };
    const purchaseCommand = c.newCommandId();
    const purchased = await purchase.purchase(ctx, purchaseInput, purchaseCommand);
    assert.equal((await models.listMediaUsageFactPage(ctx, { dialogId: "5678" })).facts[0].soldCount, 1);
    await purchase.purchase(
      ctx,
      {
        dialogId: "5678",
        messageId: "201",
        kind: "canonical",
        revision: "4",
        opened: false,
        observedAt: new Date().toISOString(),
      },
      c.newCommandId()
    );
    await dialogs.commitScanPage(
      ctx,
      {
        dialogId: "5678",
        messages: [{ ...paid, text: "Edited after purchase", changedAt: "2026-10-26T12:00:00.000Z" }],
        statePatch: {},
      },
      c.newCommandId()
    );
    assert.deepEqual(await purchase.purchase(ctx, purchaseInput, purchaseCommand), purchased);
    assert.equal((await models.listMediaUsageFactPage(ctx, { dialogId: "5678" })).facts[0].soldCount, 0);
    const metrics = await models.getDailyMessageMetricsRows(ctx, { startDate: "2026-10-25", endDate: "2026-10-25" });
    assert.equal(Number(metrics.rows[0].total_messages), 4);
    assert.equal(Number(metrics.rows[0].ppv_purchased), 0);
    assert.equal((await models.listVaultSalesRows(ctx, { assetId: "901" })).count, 1);
    const fresh = await dialogs.getState(ctx, { dialogId: "5678" });
    assert.ok(fresh.storageUsedBytes > 0);
    const relayDown = new HistoryRelay(dialogs, {
      receiveHistory: async () => {
        throw new Error("CRM_OFFLINE");
      },
    });
    await assert.rejects(() => relayDown.scope(ctx), /CRM_OFFLINE/);
    await dialogs.commitScanPage(
      ctx,
      { dialogId: "5678", messages: [message(ctx, "301")], statePatch: {} },
      c.newCommandId()
    );
    await db.$executeRawUnsafe("UPDATE dialog_archive_outbox SET retry_at=now() WHERE scope_id=$1", ctx.scopeId);
    await relay.scope(ctx);
    assert.ok(
      (
        await c.rows(
          db,
          "SELECT revision-acknowledged_revision debt FROM dialog_archive_outbox WHERE scope_id=$1",
          ctx.scopeId
        )
      ).every((r) => Number(r.debt) === 0)
    );
    await db.$executeRawUnsafe(
      "UPDATE dialog_archive_scope SET quota_bytes=used_bytes+100 WHERE scope_id=$1",
      ctx.scopeId
    );
    const state = await dialogs.getState(ctx, { dialogId: "5678" });
    await assert.rejects(
      () =>
        dialogs.commitScanPage(
          ctx,
          { dialogId: "5678", messages: [message(ctx, "102", "x".repeat(2000))], statePatch: { scanCursorId: "102" } },
          c.newCommandId()
        ),
      { code: "DIALOG_STORAGE_LIMIT" }
    );
    assert.equal((await dialogs.getMessages(ctx, { dialogId: "5678" })).length, 4);
    assert.equal((await dialogs.getState(ctx, { dialogId: "5678" })).scanCursorId, state.scanCursorId);
    const raceCtx = { ...ctx, agencyId: "race-agency", scopeId: c.scopeId("race-agency", ctx.platformCreatorId) };
    await dialogs.scope(raceCtx);
    await db.$executeRawUnsafe(
      "UPDATE dialog_archive_scope SET collection_from='2026-01-01' WHERE scope_id=$1",
      raceCtx.scopeId
    );
    await c.transaction(db, (tx) => dialogs.thread(raceCtx, "5678", tx));
    await db.$executeRawUnsafe(
      "UPDATE dialog_archive_scope SET quota_bytes=used_bytes+10000 WHERE scope_id=$1",
      raceCtx.scopeId
    );
    const races = await Promise.allSettled(
      ["901", "902"].map((id) =>
        dialogs.commitScanPage(
          raceCtx,
          { dialogId: "5678", messages: [message(raceCtx, id)], statePatch: {} },
          c.newCommandId()
        )
      )
    );
    assert.equal(races.filter((r) => r.status === "fulfilled").length, 1, "quota race allows only the page that fits");
    assert.equal(races.find((r) => r.status === "rejected").reason.code, "DIALOG_STORAGE_LIMIT");
    const quota = await dialogs.getStatus(raceCtx);
    assert.ok(quota.usedBytes <= quota.limitBytes);
    const { reconcile } = require("../database/reconcile-conversations");
    const preRestore = await dialogs.beginInput(ctx, scope);
    await reconcile(db, { dialogsRestored: true });
    await assert.rejects(() => dialogs.validateInput(ctx, preRestore), { code: "HISTORY_INPUT_CONFLICT" });
    await assert.rejects(
      () =>
        dialogs.commitScanPage(
          ctx,
          {
            dialogId: "5678",
            messages: [],
            statePatch: {},
            frontier: { episode: "old-restore", storageEpoch: preRestore.epoch, cursor: null, nextCursor: null },
          },
          c.newCommandId()
        ),
      { code: "HISTORY_INPUT_CONFLICT" }
    );
    const beforeIdentity = await c.rows(crm.db, "SELECT fan_id,profile,revision FROM crm_profile WHERE scope_id=$1 ORDER BY fan_id", ctx.scopeId);
    let identityHead = 20n;
    crm.canonical = {
      revision: async () => identityHead,
      read: async (scope, ids) => {
        assert.equal(scope.agencyId, ctx.agencyId);
        return ids.map(id => ({ onlyFansUserId: id, platformIdentity: { username: `canonical${id}`, platformDisplayName: `Current ${id}` } }));
      },
    };
    const currentPanel = await crm.getPanelSnapshot(ctx, { dialogId: "5678" });
    assert.equal(currentPanel.profile.platformUsername, "canonical5678");
    assert.equal((await crm.getProfile(ctx, "99999999")).platformUsername, "canonical99999999");
    const currentPage = await crm.readPage(ctx, {});
    assert.ok(currentPage.rows.every(row => row.profile.platformUsername === `canonical${row.fanId}`));
    assert.equal(currentPage.revision, await crm.readRevision(ctx));
    identityHead++;
    await assert.rejects(crm.readPage(ctx, { revision: currentPage.revision }), { code: "CAMPAIGN_SOURCE_CHANGED" });
    assert.deepEqual(await c.rows(crm.db, "SELECT fan_id,profile,revision FROM crm_profile WHERE scope_id=$1 ORDER BY fan_id", ctx.scopeId), beforeIdentity);
    const { readCapacity, assertCapacity } = require("../../src/services/conversation-storage/capacity");
    const measured = await readCapacity(db, "dialogs", 850000000);
    assert.ok(measured.usedBytes > 0); assert.ok(measured.databases.length);
    assert.throws(() => assertCapacity({ ...measured, maxBytes: 1 }), e => e.code === "CONVERSATION_DATABASE_CAPACITY" && e.capacity.usedBytes === measured.usedBytes);
    console.log("184 canonical CRM identity/read-only composition, campaign source fence and physical capacity SQL PASS");
    console.log(
      "conversation-storage: independent schemas; identity/isolation; page/expired receipt replay; collector terminal/restore fences; history rewrite fences; CRM outage recovery; manual conflicts/notes; AI checkpoint, lease takeover and atomic completion; purchase withdrawal; media/daily projections; quota rollback PASS"
    );
  } finally {
    await f.close();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { fixture, message, adapter };
