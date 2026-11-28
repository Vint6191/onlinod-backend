'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');

async function runLiveCases(h, check) {
  const desktop = h.desktop;
  const { native } = await import(pathToFileURL(path.join(h.desktopRoot, 'apps/desktop/scripts/helpers/phase5-native-sqlite.mjs')).href);
  const factory = desktop.SqliteConnectionFactory.prototype, originalOpen = factory.open;
  // Production outbox SQL, transactions and service; the native driver port is
  // real node:sqlite because Electron's better-sqlite3 ABI is not a Node ABI.
  factory.open = filename => native(filename);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-chain212-live-'));
  const filename = path.join(directory, 'analytics.sqlite');
  let outbox, service;
  const dbRead = fn => { const sql = new DatabaseSync(filename); try { return fn(sql); } finally { sql.close(); } };
  try {
    const s = await h.scope('legacy_live_upgrade');
    const at = new Date(Date.now() - 60000).toISOString();
    const current = { id: 'already-v3', type: 'tip', amount: 25, user: { id: '123' }, createdAt: at };
    await h.full(s, { tips: [current], all_reconciliation: [current] });
    const principal = { authorizationScopeIncarnation: 'notification-upgrade-login', userId: s.userId, memberId: s.member.id, agencyId: s.agencyId };
    const capturedAt = new Date().toISOString();
    const provenance = { version: 1, ...principal, accessEpoch: s.member.accessEpoch, creatorCatalogGeneration: 1, creatorId: s.creatorId, capturedAt };
    const authorization = { getSnapshot: () => ({ principal, accessEpoch: s.member.accessEpoch,
      creatorCatalogGeneration: 1, quarantineState: 'CURRENT', allowedCreatorIds: [s.creatorId] }),
      evaluateCurrentDataProcess: () => ({ allowed: true }) };
    const processor = h.load('./src/services/data-change-processor-service');
    const requests = [], responses = [], faults = {};
    const api = { deviceId: s.deviceId, async request(url, options) {
      assert.equal(url, `/api/stats/creators/${encodeURIComponent(s.creatorId)}/notifications/live`);
      const input = structuredClone(options.body); requests.push(input);
      const accepted = await h.write(tx => processor.processLiveNotificationBatch({ db: tx,
        creator: s.creator, member: s.member, device: s.device, input }));
      const response = { ok: true, ...accepted }; responses.push(response);
      if (faults.hold) { const held = faults.hold; delete faults.hold; held.entered(); await held.wait; }
      if (faults.after) { delete faults.after; throw new Error('fixture live reply lost after PostgreSQL commit'); }
      return response;
    } };
    function reopen() {
      outbox = new desktop.CreatorAnalyticsLiveOutbox(filename);
      service = new desktop.CreatorAnalyticsLiveService({ outbox, api, authorization, log: { warn() {} } });
    }
    reopen();
    // Exact prior wire shape: the v2 bug interpreted an empty cents field plus
    // a $5 token as five cents. Do not upcast its bounded diagnostic evidence.
    const legacy = h.live(s, { ...current, amount: undefined, amountCents: '', replacePairs: { '{AMOUNT}': '5' } }).canonical;
    legacy.normalizerVersion = 'notification-source-v2';
    legacy.notificationObservation.normalizerVersion = 'notification-source-v2';
    legacy.notificationFact.normalizerVersion = 'notification-source-v2';
    legacy.notificationObservation.amountCents = 5; legacy.notificationFact.amountCents = 5;
    const modern = h.live(s, { id: 'queued-v3', type: 'tip', amount: 7, user: { id: '123' }, createdAt: at }).canonical;
    outbox.enqueueDurable({ id: 'legacy-queued', creatorId: s.creatorId, eventKey: 'legacy-event-key', event: legacy, provenance });
    outbox.enqueueDurable({ id: 'modern-queued', creatorId: s.creatorId, eventKey: 'modern-event-key', event: modern, provenance });
    const originalLegacyRow = dbRead(sql => sql.prepare("SELECT * FROM analytics_live_outbox WHERE id='legacy-queued'").get());
    const originalModernRow = dbRead(sql => sql.prepare("SELECT * FROM analytics_live_outbox WHERE id='modern-queued'").get());

    await check('legacy v2 live delivery commits a repair obligation without changing a v3 fact and retains SQLite evidence when its reply is lost', async () => {
      faults.after = true; await service.flush();
      assert.equal(requests.length, 1, 'a later v3 sequence waits for the earlier ACK');
      assert.equal(requests[0].normalizerUpgradeProtocol, 1);
      assert.deepEqual(requests[0].events, [legacy]); assert.equal(responses[0].normalizerUpgrade.fromVersion, 'notification-source-v2');
      assert.equal(responses[0].normalizerUpgrade.toVersion, 'notification-source-v3');
      assert.ok(['REPAIR_QUEUED', 'REPAIR_COVERED'].includes(responses[0].normalizerUpgrade.status));
      assert.equal(outbox.count(), 2); assert.equal(dbRead(sql => sql.prepare('SELECT COUNT(*) n FROM analytics_live_normalizer_quarantine').get().n), 0);
      const fact = await h.db.creatorTip.findFirst({ where: { creatorId: s.creatorId, externalNotificationId: current.id } });
      assert.equal(fact.amountCents, 2500); assert.equal(await h.db.creatorTip.count({ where: { creatorId: s.creatorId } }), 1);
      assert.equal(dbRead(sql => sql.prepare('SELECT acked_seq FROM analytics_live_capture').get().acked_seq), 0);
    });

    await check('SQLite restart replays the immutable legacy sequence, archives its original payload after repair ACK, and delivers the following v3 sequence without a gap', async () => {
      service.destroy(); service = null;
      dbRead(sql => sql.exec('UPDATE analytics_live_outbox SET next_attempt_at=0'));
      reopen(); await service.flush();
      assert.equal(requests.length, 3); assert.deepEqual(requests[1], requests[0]);
      assert.deepEqual(requests[2].events, [modern]);
      assert.equal(Object.hasOwn(requests[2], 'normalizerUpgradeProtocol'), false);
      assert.equal(requests[2].delivery.entries[0].seq, originalModernRow.delivery_seq);
      assert.equal(responses[1].normalizerUpgrade.receiptId, responses[0].normalizerUpgrade.receiptId);
      assert.equal(outbox.count(), 0);
      const archived = dbRead(sql => sql.prepare('SELECT * FROM analytics_live_normalizer_quarantine').get());
      const original = JSON.parse(archived.original_row_json);
      assert.equal(original.event_json, originalLegacyRow.event_json); assert.equal(original.event_key, originalLegacyRow.event_key);
      assert.equal(original.delivery_session_id, originalLegacyRow.delivery_session_id); assert.equal(original.delivery_seq, originalLegacyRow.delivery_seq);
      assert.equal(JSON.parse(archived.upgrade_receipt_json).receiptId, responses[0].normalizerUpgrade.receiptId);
      const capture = dbRead(sql => sql.prepare('SELECT * FROM analytics_live_capture').get());
      assert.equal(capture.captured_seq, 2); assert.equal(capture.acked_seq, 2); assert.equal(capture.loss, 1);
      assert.equal(capture.loss_revision, 1);
      assert.equal((await h.db.creatorTip.findFirst({ where: { creatorId: s.creatorId, externalNotificationId: current.id } })).amountCents, 2500);
      assert.equal((await h.db.creatorTip.findFirst({ where: { creatorId: s.creatorId, externalNotificationId: 'queued-v3' } })).amountCents, 700);
    });

    await check('a full v3 source proof settles notification upgrade debt without inventing financial recovery or creating another repair generation on replay', async () => {
      const latest = { id: 'queued-v3', type: 'tip', amount: 7, user: { id: '123' }, createdAt: at };
      const proof = await h.full(s, { tips: [current, latest], all_reconciliation: [current, latest] });
      assert.equal(proof.job.status, 'DONE'); assert.equal(proof.state.normalizerVersion, 'notification-source-v3');
      assert.ok(proof.state.fullBackfillVerifiedAt);
      const before = await h.db.jobInstance.count({ where: { creatorId: s.creatorId, jobKey: 'catchup_notifications_scan' } });
      const replay = { ...structuredClone(requests[0]), batchId: 'live_legacy_replay_alternate_batch_212' };
      const result = await h.write(tx => processor.processLiveNotificationBatch({ db: tx, creator: s.creator,
        member: s.member, device: s.device, input: replay }));
      assert.equal(result.normalizerUpgrade.receiptId, responses[0].normalizerUpgrade.receiptId);
      // No financial provider was read in this notification case. Its separate
      // obligation must stay pending instead of borrowing a notification proof.
      assert.equal(result.normalizerUpgrade.status, 'REPAIR_QUEUED');
      const debts = await h.db.creatorRecoveryIntent.findMany({ where: { creatorId: s.creatorId } });
      assert.ok(debts.filter(row => row.stream === 'notifications' && row.reason === 'NOTIFICATION_NORMALIZER_UPGRADE').every(row => row.status === 'COMPLETE'));
      assert.ok(debts.some(row => row.stream === 'financial' && row.reason === 'FINANCIAL_PROOF_ADOPTION_FULL' && row.status !== 'COMPLETE'));
      assert.equal(await h.db.jobInstance.count({ where: { creatorId: s.creatorId, jobKey: 'catchup_notifications_scan' } }), before);
      assert.equal((await h.db.creatorTip.findFirst({ where: { creatorId: s.creatorId, externalNotificationId: current.id } })).amountCents, 2500);
    });

    await check('quarantine and sequence acknowledgement are one durable SQLite transaction and survive an archive write failure', async () => {
      const later = structuredClone(legacy); later.notificationObservation.sourceEvidence.text = 'Retained migration diagnostic';
      outbox.enqueueDurable({ id: 'legacy-archive-failure', creatorId: s.creatorId,
        eventKey: 'legacy-archive-failure-key', event: later, provenance: { ...provenance, capturedAt: new Date().toISOString() } });
      dbRead(sql => sql.exec(`CREATE TRIGGER fail_quarantine BEFORE INSERT ON analytics_live_normalizer_quarantine
        WHEN NEW.id='legacy-archive-failure' BEGIN SELECT RAISE(ABORT,'fixture archive write interrupted'); END;`));
      await service.flush(); assert.equal(outbox.count(), 1);
      assert.equal(dbRead(sql => sql.prepare('SELECT acked_seq FROM analytics_live_capture').get().acked_seq), 2);
      assert.equal(dbRead(sql => sql.prepare('SELECT COUNT(*) n FROM analytics_live_normalizer_quarantine').get().n), 1);
      const beforeRetry = requests.at(-1), receipt = responses.at(-1).normalizerUpgrade.receiptId;
      service.destroy(); service = null;
      dbRead(sql => sql.exec('DROP TRIGGER fail_quarantine; UPDATE analytics_live_outbox SET next_attempt_at=0'));
      reopen(); await service.flush();
      assert.deepEqual(requests.at(-1), beforeRetry); assert.equal(responses.at(-1).normalizerUpgrade.receiptId, receipt);
      assert.equal(outbox.count(), 0); assert.equal(dbRead(sql => sql.prepare('SELECT acked_seq FROM analytics_live_capture').get().acked_seq), 3);
      assert.equal(dbRead(sql => sql.prepare('SELECT COUNT(*) n FROM analytics_live_normalizer_quarantine').get().n), 2);
      assert.equal(dbRead(sql => sql.prepare('SELECT loss_revision FROM analytics_live_capture').get().loss_revision), 2);
      assert.equal((await h.db.creatorTip.findFirst({ where: { creatorId: s.creatorId, externalNotificationId: current.id } })).amountCents, 2500);
    });

    await check('stopping with a committed live ACK in flight closes promptly, preserves SQLite evidence and recovers once after restart', async () => {
      const event = h.live(s, { id: 'stop-in-flight', type: 'tip', amount: 9, user: { id: '123' }, createdAt: at }).canonical;
      outbox.enqueueDurable({ id: 'stop-in-flight', creatorId: s.creatorId, eventKey: 'stop-in-flight-key', event,
        provenance: { ...provenance, capturedAt: new Date().toISOString() } });
      let entered, release;
      const started = new Promise(resolve => { entered = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      faults.hold = { entered, wait };
      const flushing = service.flush(); await started;
      const before = Date.now(); service.destroy(); service = null;
      assert.ok(Date.now() - before < 1000, 'shutdown cannot await a network reply');
      release(); await flushing;
      assert.equal(dbRead(sql => sql.prepare('SELECT COUNT(*) n FROM analytics_live_outbox').get().n), 1);
      assert.equal(dbRead(sql => sql.prepare('SELECT acked_seq FROM analytics_live_capture').get().acked_seq), 3);
      const beforeRetry = requests.at(-1); reopen(); await service.flush();
      assert.deepEqual(requests.at(-1), beforeRetry); assert.equal(outbox.count(), 0);
      assert.equal(dbRead(sql => sql.prepare('SELECT acked_seq FROM analytics_live_capture').get().acked_seq), 4);
      assert.equal(await h.db.creatorTip.count({ where: { creatorId: s.creatorId, externalNotificationId: 'stop-in-flight' } }), 1);
    });
  } finally {
    service?.destroy(); factory.open = originalOpen; fs.rmSync(directory, { recursive: true, force: true });
  }
}
module.exports = { runLiveCases };
