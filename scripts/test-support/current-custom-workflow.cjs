"use strict";
const assert = require("node:assert/strict"),
  path = require("node:path"),
  crypto = require("node:crypto"),
  fs = require("node:fs");
exports.runCustoms = async function runCustoms(f) {
  const {
    modules,
    must,
    manage,
    command,
    api,
    auth,
    login,
    agencyId,
    deviceId,
    creatorId: c,
    creatorIds,
    transport,
    pass,
    results,
    scratch,
  } = f;
  const { CustomOrdersService, DesktopCurrentAuthorizationAuthorityService, VaultService, ProgrammaticOfWriteClient } =
    modules;
  const tgCommand = (action, targetId, payload) =>
    must(
      "POST",
      "/api/telegram-control/commands/v1",
      command(action, targetId, { ...payload, deviceId, originAuthorizationSessionId: login.authorizationSessionId })
    );
  const added = await tgCommand("telegram.create", "", { apiId: 12345, apiHash: "a".repeat(32) });
  const accountId = added.result.accountId;
  const material = await must("POST", `/api/settings/telegram/accounts/${accountId}/local-material`, {
    deviceId,
    purpose: "authorize",
  });
  await tgCommand("telegram.session", accountId, {
    expectedCredentialRevision: material.material.credentialRevision,
    session: "controlled-fixture-session",
  });
  await manage("creator.telegramContact", c, {
    telegramContact: "@model_one_fixture",
    telegramAccountId: accountId,
    expectedContact: null,
    expectedAccountId: null,
  });
  const runtime = await must("POST", "/api/settings/telegram/runtime/claim", { deviceId, accountId, limit: 1 });
  assert.equal(runtime.leases.length, 1);
  const lease = runtime.leases[0];
  const defaults = await must("GET", "/api/settings/workspace");
  await manage("workspace.update", "", { expectedRevision: defaults.revision, vaultUploadRecipient: "fixture_relay" });
  await manage("custom.destination", c, { folderId: "900", expectedFolderId: null, expectedRevision: 0 });
  pass("Telegram connection, stable creator binding, runtime lease and pinned Custom destination");
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const authStore = { ...auth, readSession: () => ({ ...auth.readSession(), deviceId }), getDeviceId: () => deviceId };
  const authority = new DesktopCurrentAuthorizationAuthorityService({
    log,
    authStore,
    accessRuntime: {
      currentAuthorityProof: () => ({ accessEpoch: 1, creatorCatalogGeneration: 1 }),
      allowedCreatorIdsSnapshot: () => creatorIds,
    },
  });
  const publish = () =>
    authority.publish({
      accessEpoch: 1,
      creatorCatalogGeneration: 1,
      role: "OWNER",
      roleKey: "owner",
      effectivePermissions: {
        "content.manage_vault": true,
        "content.review_customs": true,
        "content.delete_posts": true,
      },
      allowedCreatorIds: creatorIds,
      observedAt: Date.now(),
      observedAtMono: performance.now(),
      billing: {
        version: 1,
        validForMs: 90000,
        creators: creatorIds.map((creatorId) => ({ creatorId, allowed: true, validForMs: 90000, reason: "TRIAL" })),
      },
    });
  publish();
  const faults = [],
    faultEvents = [],
    nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.origin, api.apiBase, "Fixture may only contact its isolated Backend");
    const fault = faults.find((x) => x.remaining > 0 && x.match(url.pathname));
    if (fault && fault.phase === "before") {
      fault.remaining--;
      faultEvents.push({ tag: fault.tag, phase: "before", path: url.pathname });
      throw Object.assign(Error("controlled request outage"), { code: "TEST_REQUEST_UNAVAILABLE" });
    }
    const response = await nativeFetch(input, options);
    if (fault && fault.phase === "after") {
      fault.remaining--;
      await response.clone().text();
      faultEvents.push({ tag: fault.tag, phase: "after", path: url.pathname, status: response.status });
      assert.ok(response.ok);
      throw Object.assign(Error("controlled response loss after server commit"), { code: "TEST_RESPONSE_LOST" });
    }
    return response;
  };
  const fault = (tag, match, phase = "after", remaining = 1) => {
    const row = { tag, match, phase, remaining };
    faults.push(row);
    return row;
  };
  const until = async (test, label, timeout = 12000, interval = 30) => {
    const deadline = Date.now() + timeout;
    while (!(await test())) {
      assert.ok(Date.now() < deadline, label);
      await new Promise((r) => setTimeout(r, interval));
    }
  };
  const sends = [];
  let unknownTelegram = false;
  const tg = {
    runtimeLeaseSnapshot: () => [{ accountId, claimToken: lease.claimToken }],
    executionContext: async (id) => {
      assert.equal(id, accountId);
      return { deviceId, claimToken: lease.claimToken };
    },
    resolveCreator: async () => {
      const row = (await must("GET", `/api/creators/${c}`)).creator;
      return must("PATCH", `/api/creators/${c}/telegram-identity`, {
        telegramUserId: "800001",
        telegramContact: row.telegramContact,
        expectedCreatorUpdatedAt: row.updatedAt,
      });
    },
    sendCustomDeliveryMessage: async (input) => {
      assert.equal(input.creatorId, c);
      sends.push(input);
      if (unknownTelegram) {
        unknownTelegram = false;
        throw Object.assign(Error("controlled provider lost outcome"), { code: "TELEGRAM_MESSAGING_DELIVERY_UNKNOWN" });
      }
      return { messageId: String(5000 + sends.length), telegramUserId: "800001", sentAt: new Date().toISOString() };
    },
  };
  const composer = {
    calls: [],
    async attachPreparedDraft(input) {
      this.calls.push(input);
      return {
        ok: true,
        attachedCount: input.freeMediaIds.length + input.paidMediaIds.length,
        priceCents: input.priceCents,
      };
    },
  };
  const media = [],
    ofCalls = [],
    relays = [];
  const ofApi = {
    getStatus: () => ({ status: "READY" }),
    async uploadLocalMedia(input) {
      assert.ok(fs.statSync(input.filePath).size > 0);
      return {
        ok: true,
        descriptor: {
          extra: "controlled-extra",
          host: "fixture.invalid",
          name: "controlled.bin",
          processId: "controlled-upload",
        },
        uploadedBytes: 16,
        totalBytes: 16,
      };
    },
    async request(input) {
      ofCalls.push({ source: input.source, endpoint: input.endpoint });
      const success = (data) => ({ ok: true, status: 200, data });
      if (input.source === "vault.localUpload.resolveRecipient")
        return success({ id: 900001, username: "fixture_relay" });
      if (input.source === "vault.relay.preflight.me") return success({ id: 100001 });
      if (input.source === "vault.relay.preflight.messages") return success({ list: [] });
      if (input.source === "customs.relay.commit") {
        assert.equal(input.writeAuthorityContext.authorityKind, "PROGRAMMATIC_OF_WRITE");
        assert.equal(input.endpoint.body.mediaFiles.length, 1);
        assert.equal(input.endpoint.body.mediaFiles[0].processId, "controlled-upload");
        const item = {
          id: String(90001 + media.length),
          type: "video",
          isReady: true,
          files: {
            full: { url: "https://fixture.invalid/media" },
            thumb: { url: "https://fixture.invalid/thumb" },
            preview: { url: "https://fixture.invalid/preview" },
          },
        };
        media.push(item);
        const message = { id: String(910001 + relays.length), media: [item] };
        relays.push(message);
        return success(message);
      }
      if (input.source === "vault.localUpload.batchMove") return success({ success: true });
      if (input.endpoint.path?.includes("/vault/lists") && !input.endpoint.path?.includes("/media"))
        return success({
          list: [{ id: 900, name: "Customs", type: "custom", canUpdate: true, canDelete: true }],
          hasMore: false,
          canCreateVaultLists: true,
        });
      if (input.endpoint.path?.includes("/vault/media")) return success({ list: media, hasMore: false });
      throw Error("UNMODELED_PROVIDER_CALL:" + JSON.stringify(ofCalls.at(-1)));
    },
  };
  tg.downloadCreatorMessages = async ({ messageIds, targetDir }) => {
    const file = path.join(targetDir, "controlled.bin");
    fs.writeFileSync(file, Buffer.alloc(16, 3));
    return { files: messageIds.map((messageId) => ({ messageId, path: file })) };
  };
  const writes = new ProgrammaticOfWriteClient(authStore, {
    ensureSession: async () => ({ authenticated: true, session: authStore.readSession() }),
  });
  const vault = new VaultService({
    log,
    ofApi,
    writes,
    authorization: authority,
    coordinator: { registerHandler: () => () => {} },
    directoryBackend: {},
    mediaLibrary: {},
    getMainWindow: () => null,
  });
  const stores = Object.fromEntries(
    [
      "vaultDestinationIntentDatabasePath",
      "telegramDeliveryDatabasePath",
      "deliveryConfirmationDatabasePath",
      "nativeMassSettlementDatabasePath",
      "pageWriteSettlementDatabasePath",
    ].map((key) => [key, path.join(scratch, key + ".sqlite")])
  );
  let rollbackProved = false;
  const customApi = {
    ...api,
    async request(url, options = {}) {
      if (!rollbackProved && url.endsWith("/relay-write/reserve")) {
        const submissionId = url.split("/")[4],
          body = options.body;
        await f.withDatabase(async (db, load, queries) => {
          const { runDbTransaction } = load("./src/services/db-transaction-service");
          const {
            reserveCustomContentSubmissionRelayWrite,
            closeCustomContentSubmissionRelayWriteUnresolved,
            resolveCustomContentSubmissionRelayWriteMatched,
          } = load("./src/services/custom-content-submissions-service");
          const member = await db.agencyMember.findUnique({ where: { id: login.activeMemberId } });
          const before = await db.customContentSubmission.findUnique({ where: { id: submissionId } });
          const beforeWork = await db.domainWorkItem.findMany({
            where: { objectId: submissionId },
            orderBy: { id: "asc" },
          });
          const key = `custom-relay:${submissionId}:${body.expectedIndex}`,
            offset = queries.length;
          const rollback = Error("EXPECTED_OUTER_ROLLBACK");
          await assert.rejects(
            runDbTransaction(db, async (tx) => {
              const reserved = await reserveCustomContentSubmissionRelayWrite({
                ...body,
                expectedTelegramMessageId: body.telegramMessageId,
                submissionId,
                agencyId,
                member,
                accessEpoch: login.accessEpoch,
                db: tx,
              });
              assert.ok(reserved.delivery.id);
              assert.ok(await tx.automationDelivery.findUnique({ where: { idempotencyKey: key } }));
              // Seed a synthetic unknown outcome only inside the rollback fixture.
              // Exercise both operator settlement entry points with the same SQL owner.
              await tx.automationDelivery.update({
                where: { id: reserved.delivery.id },
                data: { status: "RECONCILE_REQUIRED" },
              });
              const binding = {
                agencyId,
                member,
                deviceId,
                submissionId,
                expectedIndex: body.expectedIndex,
                writeId: reserved.delivery.id,
                accessEpoch: login.accessEpoch,
                db: tx,
              };
              const closed = await closeCustomContentSubmissionRelayWriteUnresolved({
                ...binding,
                leaseToken: reserved.lease.token,
                leaseRevision: reserved.lease.revision,
                reason: "Controlled unresolved proof",
              });
              assert.equal(closed.delivery.failureCode, "outcome_unresolved_do_not_retry");
              const matched = await resolveCustomContentSubmissionRelayWriteMatched({
                ...binding,
                mediaId: "rollback-only-media",
                messageId: "rollback-only-message",
              });
              assert.equal(matched.delivery.status, "COMPLETED");
              throw rollback;
            }),
            (error) => error === rollback
          );
          assert.equal(await db.automationDelivery.count({ where: { idempotencyKey: key } }), 0);
          assert.deepEqual(await db.customContentSubmission.findUnique({ where: { id: submissionId } }), before);
          assert.deepEqual(
            await db.domainWorkItem.findMany({ where: { objectId: submissionId }, orderBy: { id: "asc" } }),
            beforeWork
          );
          const transactionQueries = queries.slice(offset).map((x) => x.query);
          assert.equal(transactionQueries.filter((x) => /^BEGIN/.test(x)).length, 1);
          assert.equal(transactionQueries.filter((x) => /^ROLLBACK/.test(x)).length, 1);
          results.transactionRollback = {
            singleRoot: true,
            reservationAndOperatorSettlementRolledBack: true,
            submissionUnchanged: true,
            sourceClaimUnchanged: true,
          };
        });
        rollbackProved = true;
        pass("Real SQL: source claim and relay reservation share one root and roll back together");
      }
      return api.request(url, options);
    },
  };
  let sendGuard, networkListener;
  const creatorRuntime = {
    getAll: () => Object.fromEntries(creatorIds.map((id) => [id, { status: "READY" }])),
    async setManualMessageSendGuard(id, guard) {
      if (id === c) sendGuard = guard;
    },
    onNetworkAction(listener) {
      networkListener = listener;
      return () => {};
    },
    onStateChanged: () => () => {},
    waitForAllPageWriteDrain: async () => {},
  };
  const dependencies = {
    ...stores,
    authorization: authority,
    managementCommands: transport,
    dialogMediaPicker: composer,
    creatorRuntime,
    ofApi,
    getCurrentActorIdentity: () => ({ agencyId, memberId: login.activeMemberId, userId: login.user.id }),
  };
  let custom = new CustomOrdersService(customApi, tg, vault, deviceId, dependencies);
  const restart = async (killBackend = false) => {
    await until(() => !custom.pageWriteSettlementBusy, "settlement drain");
    await custom.prepareShutdown();
    custom.destroy();
    if (killBackend) {
      await f.stop("SIGKILL");
      await f.boot();
    }
    publish();
    custom = new CustomOrdersService(customApi, tg, vault, deviceId, dependencies);
    await custom.initializeRuntimeGuards();
  };
  try {
    const created = await custom.create({
      clientMutationId: crypto.randomUUID(),
      creatorId: c,
      dialogId: "700001",
      type: "CONTENT",
      contentKind: "VIDEO",
      scenario: "Controlled custom request",
      price: 30,
      paidAmount: 10,
    });
    results.customCreated = created;
    assert.equal(created.telegramDelivery.delivered, true);
    assert.equal(sends.length, 1);
    const order = created.order;
    await custom.sendTelegram({ creatorId: c, orderId: order.id });
    assert.equal(sends.length, 1);
    pass("Actual Desktop Custom service creates order and confirms exactly one Telegram TASK");
    const inbound = {
      accountId,
      deviceId,
      claimToken: lease.claimToken,
      senderTelegramUserId: "800001",
      messageId: "6001",
      replyToMessageId: "5001",
      hasMedia: true,
      text: "Controlled media reply",
      sentAt: new Date().toISOString(),
    };
    const ingested = await must("POST", "/api/custom-orders/telegram-inbound", inbound);
    results.inbound = ingested;
    await must("POST", "/api/custom-orders/telegram-inbound", inbound);
    let submissions;
    await until(
      async () => {
        submissions = await must("GET", `/api/custom-orders/submissions?creatorId=${c}&customOrderId=${order.id}`);
        return submissions.items.length > 0;
      },
      "initial background inbound projection",
      30000,
      250
    );
    results.submissions = submissions;

    assert.equal(submissions.items.length, 1);
    pass("Telegram reply ingestion and exact inbound replay");
    fault(
      "relay-complete-response-loss",
      (p) => p.startsWith("/api/programmatic-of-writes/") && p.endsWith("/complete")
    );
    const relayRecoveryStartedAt = Date.now();
    const upload = await custom.runSubmissionUploadPass();
    results.upload = upload;
    assert.equal(relays.length, 1);
    let reviewed,
      lastRuntimeRefresh = Date.now();
    await until(
      async () => {
        if (Date.now() - lastRuntimeRefresh > 20000) {
          const renewed = await must("POST", "/api/settings/telegram/runtime/claim", { deviceId, accountId, limit: 1 });
          assert.equal(renewed.leases.length, 1);
          Object.assign(lease, renewed.leases[0]);
          publish();
          lastRuntimeRefresh = Date.now();
        }
        await custom.runSubmissionUploadPass();
        reviewed = await must("GET", "/api/custom-orders/review-queue");
        return reviewed.items.some((x) => x.customOrderId === order.id);
      },
      "confirmed relay projection recovery after the real retry delay",
      110000,
      1000
    );
    assert.equal(relays.length, 1);
    pass("Lost relay completion acknowledgement recovers canonical media without a second provider send");
    results.relayRecovery = {
      elapsedMs: Date.now() - relayRecoveryStartedAt,
      physicalRelayCalls: relays.length,
      retryClockAltered: false,
    };
    results.reviewQueue = reviewed;
    const item = reviewed.items.find((x) => x.customOrderId === order.id);
    assert.ok(item);
    const approved = await must("POST", `/api/custom-orders/submissions/${submissions.items[0].id}/review`, {
      action: "APPROVE",
      expectedCustomOrderId: order.id,
      expectedBindingRevision: item.bindingRevision,
      comment: "Controlled review approval",
    });
    results.approved = approved;
    const ready = await must("GET", `/api/custom-orders/ready-deliveries/${order.id}`);
    results.ready = ready;
    pass(
      "Actual Custom and Vault upload workflow, relay write authority, folder settlement, canonical media and review"
    );
    const prepared = await custom.prepareDelivery({ customOrderId: order.id });
    results.prepared = prepared;
    assert.equal(prepared.priceCents, 2000);
    assert.deepEqual(composer.calls[0].paidMediaIds, ["90001"]);
    pass("Approved Custom prepares exact media and remaining payment in the dialog composer");
    assert.equal(typeof sendGuard, "function");
    const attempt = {
      creatorId: c,
      dialogId: "700001",
      mediaIds: ["90001"],
      priceCents: 2000,
      identityVerified: true,
      networkRequestId: "custom-fixture-send-one",
      sendKind: "DIRECT",
      queuedOrAutomated: false,
      isForward: false,
    };
    for (const change of [
      { dialogId: "700002" },
      { priceCents: 0 },
      { queuedOrAutomated: true },
      { identityVerified: false },
    ]) {
      const denied = await sendGuard({ ...attempt, ...change });
      assert.equal(denied.allow, false, JSON.stringify(change));
    }
    pass("Actual native send guard blocks wrong fan, wrong price, queue and unverified model");
    const granted = await sendGuard(attempt);
    results.granted = { ...granted, metadata: { ...granted.metadata, customDeliverySettlementToken: "[redacted]" } };
    assert.equal(granted.allow, true);
    assert.equal(granted.metadata.customDeliveryAuthorityVersion, "CUSTOM_MANUAL_V2");
    const outage = fault(
      "fan-settlement-offline",
      (p) => p.includes("/custom-manual/") && p.endsWith("/settle"),
      "before",
      100
    );
    const confirmed = {
      kind: "MANUAL_MESSAGE_SEND_CONFIRMED",
      creatorId: c,
      dialogId: "700001",
      messageId: "920001",
      mediaIds: ["90001"],
      priceCents: 2000,
      currency: "USD",
      mediaCount: 1,
      requestId: attempt.networkRequestId,
      providerStatus: 200,
      occurredAt: new Date().toISOString(),
      manualSendGuard: granted.metadata,
      webContentsId: 42,
    };
    networkListener(confirmed);
    await until(() => !custom.pageWriteSettlementBusy, "offline settlement recorded");
    assert.equal(custom.health().pendingPageWriteSettlements, 1);
    assert.equal((await sendGuard({ ...attempt, networkRequestId: "no-send-during-outage" })).allow, false);
    await restart(true);
    assert.equal(custom.health().pendingPageWriteSettlements, 1);
    assert.equal(custom.health().pendingDeliveryConfirmations, 1);
    assert.equal((await sendGuard({ ...attempt, networkRequestId: "no-send-after-restart" })).allow, false);
    outage.remaining = 0;
    fault("fan-settlement-response-loss", (p) => p.includes("/custom-manual/") && p.endsWith("/settle"));
    await until(async () => {
      await custom.flushPageWriteSettlements();
      return custom.health().pendingPageWriteSettlements === 0;
    }, "fan settlement replay");
    const delivered = await must("GET", `/api/custom-orders/${order.id}`);
    results.delivered = delivered;
    assert.equal(delivered.order.status, "COMPLETED");
    assert.ok(delivered.order.fanDeliveredAt);
    assert.equal((await sendGuard({ ...attempt, networkRequestId: "must-not-resend" })).allow, false);
    pass(
      "Durable fan receipt survives Desktop reopen and Backend SIGKILL; lost settlement acknowledgement replays without another send"
    );

    const makeOrder = (scenario) =>
      custom.create({
        clientMutationId: crypto.randomUUID(),
        creatorId: c,
        dialogId: "700001",
        type: "CONTENT",
        contentKind: "VIDEO",
        scenario,
        price: 30,
        paidAmount: 10,
      });
    fault("telegram-begin-response-loss", (p) => p.includes("/telegram-deliveries/") && p.endsWith("/begin"));
    const beforeBegin = sends.length,
      beginLost = await makeOrder("Lost begin response");
    assert.equal(beginLost.telegramDelivery.delivered, false);
    assert.equal(sends.length, beforeBegin);
    await custom.sendTelegram({ creatorId: c, orderId: beginLost.order.id });
    assert.equal(sends.length, beforeBegin + 1);
    pass("Lost Telegram begin response collapses to proven-not-sent and retries the same task exactly once");

    const confirmLoss = fault(
      "telegram-confirm-response-loss",
      (p) => p.includes("/telegram-deliveries/") && p.endsWith("/confirm"),
      "after",
      100
    );
    const beforeConfirm = sends.length,
      confirmLost = await makeOrder("Lost Telegram confirm response");
    assert.equal(sends.length, beforeConfirm + 1);
    assert.equal(custom.telegramDeliveries.settlements(100).length, 1);
    await restart();
    confirmLoss.remaining = 0;
    await custom.sendTelegram({ creatorId: c, orderId: confirmLost.order.id });
    assert.equal(sends.length, beforeConfirm + 1);
    assert.equal(custom.telegramDeliveries.settlements(100).length, 0);
    pass("Confirmed Telegram receipt survives SQLite reopen and settles without a duplicate task");

    unknownTelegram = true;
    const beforeUnknown = sends.length,
      unknown = await makeOrder("Unknown Telegram outcome");
    assert.equal(unknown.telegramDelivery.delivered, false);
    assert.equal(sends.length, beforeUnknown + 1);
    await assert.rejects(custom.sendTelegram({ creatorId: c, orderId: unknown.order.id }), {
      code: "TELEGRAM_DELIVERY_RECONCILIATION_REQUIRED",
    });
    assert.equal(sends.length, beforeUnknown + 1);
    const reconciliation = await must("GET", "/api/custom-orders/telegram-deliveries/reconciliation-required");
    assert.ok(reconciliation.items.some((x) => x.customOrderId === unknown.order.id || x.orderId === unknown.order.id));
    pass("Unknown Telegram provider outcome remains visible for reconciliation and is never resent automatically");
    const revisionOrderId = beginLost.order.id;
    const ingest = async (messageId, replyToMessageId) => {
      await must("POST", "/api/custom-orders/telegram-inbound", {
        ...inbound,
        claimToken: lease.claimToken,
        messageId,
        replyToMessageId,
        sentAt: new Date().toISOString(),
      });
      await until(
        async () => {
          const rows = await must(
            "GET",
            `/api/custom-orders/submissions?creatorId=${c}&customOrderId=${revisionOrderId}`
          );
          return rows.items.some((x) => x.telegramMessageIds.includes(messageId));
        },
        "background inbound projection",
        30000
      );
    };
    await ingest("6002", String(5000 + beforeBegin + 1));
    assert.equal((await custom.runSubmissionUploadPass()).blocked, null);
    const firstVersion = (await must("GET", "/api/custom-orders/review-queue")).items.find(
      (x) => x.customOrderId === revisionOrderId
    );
    assert.ok(firstVersion);
    const review = (item, action, comment) =>
      must("POST", `/api/custom-orders/submissions/${item.submissionId}/review`, {
        action,
        comment,
        expectedCustomOrderId: revisionOrderId,
        expectedBindingRevision: item.bindingRevision,
        expectedReviewDecisionRevision: item.reviewDecisionRevision,
      });
    await review(firstVersion, "REQUEST_REVISION", "Change the angle");
    await review(firstVersion, "REQUEST_REVISION", "Change the angle");
    const beforeRevision = sends.length;
    await custom.runTelegramDeliveryPass();
    assert.equal(sends.length, beforeRevision + 1);
    assert.match(sends.at(-1).text, /Change the angle/);
    assert.ok(sends.at(-1).replyToMessageId);
    await custom.runTelegramDeliveryPass();
    assert.equal(sends.length, beforeRevision + 1);
    await ingest("6003", String(5000 + sends.length));
    assert.equal((await custom.runSubmissionUploadPass()).blocked, null);
    const secondVersion = (await must("GET", "/api/custom-orders/review-queue")).items.find(
      (x) => x.customOrderId === revisionOrderId
    );
    assert.ok(secondVersion);
    assert.equal(secondVersion.revisionNumber, 2);
    assert.notEqual(secondVersion.submissionId, firstVersion.submissionId);
    await review(secondVersion, "APPROVE", "Revision accepted");
    const revisionReady = await custom.prepareDelivery({ customOrderId: revisionOrderId });
    assert.equal(revisionReady.priceCents, 2000);
    assert.deepEqual(composer.calls.at(-1).paidMediaIds, ["90003"]);
    pass(
      "Revision request sends once; the model reply creates version two and only approved replacement media reaches the composer"
    );
    const beforeCancel = sends.length,
      current = (await must("GET", `/api/custom-orders/${revisionOrderId}`)).order;
    await custom.update({
      creatorId: c,
      orderId: revisionOrderId,
      expectedUpdatedAt: current.updatedAt,
      patch: { status: "CANCELLED", cancelReason: "Controlled cancellation" },
    });
    assert.equal(
      (await sendGuard({ ...attempt, mediaIds: ["90003"], networkRequestId: "cancelled-must-not-send" })).allow,
      false
    );
    await custom.runTelegramDeliveryPass();
    assert.equal(sends.length, beforeCancel + 1);
    assert.equal((await must("GET", `/api/custom-orders/${revisionOrderId}`)).order.status, "CANCELLED");
    pass("Cancellation invalidates prepared delivery and sends exactly one model cancellation instruction");
    results.faultEvents = faultEvents;
    results.providerCalls = { telegram: sends.length, relay: relays.length, fanResponseProofs: 1 };
  } finally {
    await custom.prepareShutdown();
    custom.destroy();
    await vault.destroy();
    authority.destroy();
    globalThis.fetch = nativeFetch;
  }
};
