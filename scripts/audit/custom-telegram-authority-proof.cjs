'use strict';

// Isolated real PostgreSQL semantics; never connects to the application's DB.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { createScaleSqlRuntime } = require('../test-support/scale-sql-runtime.cjs');
const { scope } = require('./analytics-traffic/fixture.cjs');

(async () => {
  const runtime = await createScaleSqlRuntime();
  const { db, queries } = runtime;
  if (runtime.url) {
    process.env.DATABASE_URL = runtime.url;
    process.env.DIRECT_URL = runtime.url;
  }
  try {
    const { resolveTelegramCustomThread: resolve, CURRENT_THREAD_ORDER_PAGE_SQL, CURRENT_THREAD_PAGE_SIZE } = require('../../src/services/custom-telegram-thread-authority-service');
    const s = await scope(db);
    const at = new Date('2026-10-18T00:00:00.000Z');
    const createOrder = (id, status = 'PENDING') => db.customOrder.create({ data: {
      id, agencyId: s.agencyId, creatorId: s.creatorId, dialogId: 'fan-' + id,
      createdByMemberId: 'member-' + s.agencyId, scenario: 'proof', status, type: 'CALL',
    } });
    const createIntent = (id, orderId, overrides = {}) => db.telegramDeliveryIntent.create({ data: {
      id, agencyId: s.agencyId, creatorId: s.creatorId, customOrderId: orderId,
      accountId: 'telegram-a', kind: 'TASK', logicalKey: id, payloadFingerprint: id,
      state: 'CONFIRMED', confirmationAuthority: 'PROVIDER_RECEIPT',
      remoteMessageId: 100000 + Number(id.replace(/\D/g, '') || 1),
      remoteRecipientTelegramUserId: '900001', remoteSentAt: at, confirmedAt: at,
      ...overrides,
    } });
    const input = { agencyId: s.agencyId, accountId: 'telegram-a', senderTelegramUserId: '900001', eventSentAt: new Date(at.getTime() + 1000), db };

    // Bulk historical fixtures do not need to enqueue per-order operational
    // projection debt. Restore every production trigger before exercising the
    // resolver; only test seeding is accelerated here.
    await db.$executeRawUnsafe('SET session_replication_role = replica');
    await db.$executeRawUnsafe(`INSERT INTO "CustomOrder"
      ("id","agencyId","creatorId","dialogId","createdByMemberId","scenario","status","type","updatedAt")
      SELECT 'history-order-'||n,$1,$2,'fan-history-'||n,$3,'proof','COMPLETED','CALL',$4
      FROM generate_series(1,10000) n`, s.agencyId, s.creatorId, 'member-' + s.agencyId, at);
    await db.$executeRawUnsafe(`INSERT INTO "TelegramDeliveryIntent"
      ("id","agencyId","creatorId","customOrderId","accountId","kind","logicalKey","payloadFingerprint","state","confirmationAuthority","remoteMessageId","remoteRecipientTelegramUserId","remoteSentAt","confirmedAt","updatedAt")
      SELECT 'history-'||n,$1,$2,'history-order-'||n,'telegram-a','TASK','history-'||n,'history-'||n,'CONFIRMED','PROVIDER_RECEIPT',n,'900001',$3,$3,$3
      FROM generate_series(1,10000) n`, s.agencyId, s.creatorId, at);
    await db.$executeRawUnsafe('SET session_replication_role = origin');

    let start = queries.length;
    let result = await resolve(input);
    assert.equal(result.type, 'NO_ACTIVE_THREAD');
    let discovery = queries.slice(start);
    assert.equal(discovery.length, 1, 'zero active orders must not materialize or inspect lifetime provider facts');
    assert.match(discovery[0].query, /custom_telegram_current_order_page/);

    await createOrder('active-001');
    await createIntent('live-1', 'active-001');
    result = await resolve(input);
    assert.equal(result.type, 'UNIQUE_ACTIVE_THREAD');
    assert.equal(result.thread.customOrderId, 'active-001');
    await db.$executeRawUnsafe('ANALYZE "CustomOrder"');
    await db.$executeRawUnsafe('ANALYZE "TelegramDeliveryIntent"');
    const planRows = await db.$queryRawUnsafe('EXPLAIN (ANALYZE, FORMAT JSON) ' + CURRENT_THREAD_ORDER_PAGE_SQL,
      s.agencyId, 'telegram-a', '900001', '', CURRENT_THREAD_PAGE_SIZE);
    const plan = planRows[0]['QUERY PLAN'][0].Plan;
    const nodes = [];
    const visit = node => { nodes.push(node); for (const child of node.Plans || []) visit(child); };
    visit(plan);
    assert.equal(nodes.some(node => node['Relation Name'] === 'TelegramDeliveryIntent' && node['Node Type'] === 'Seq Scan'), false,
      'current discovery cannot sequentially scan the sender lifetime');
    assert.ok(nodes.some(node => node['Relation Name'] === 'TelegramDeliveryIntent' && /Index/.test(node['Node Type'])), JSON.stringify(plan));

    result = await resolve({ ...input, replyToMessageId: 1 });
    assert.equal(result.type, 'DIRECT_REPLY');
    assert.equal(result.thread.customOrderId, 'history-order-1');
    assert.equal(result.thread.customOrderStatus, 'COMPLETED');
    assert.equal((await resolve({ ...input, accountId: 'other-account', replyToMessageId: 1 })).type, 'DIRECT_REPLY_UNRESOLVED');
    assert.equal((await resolve({ ...input, senderTelegramUserId: '900002', replyToMessageId: 1 })).type, 'DIRECT_REPLY_RECIPIENT_CONFLICT');

    await db.telegramDeliveryIntent.update({ where: { id: 'live-1' }, data: { confirmationAuthority: 'MANUAL_RECONCILIATION' } });
    assert.equal((await resolve(input)).type, 'NO_ACTIVE_THREAD', 'manual resolution cannot claim future non-Reply media');
    await db.telegramDeliveryIntent.update({ where: { id: 'live-1' }, data: { confirmationAuthority: 'PROVIDER_RECEIPT', remoteSentAt: new Date(at.getTime() + 2000) } });
    assert.equal((await resolve(input)).type, 'NO_ACTIVE_THREAD', 'future receipt cannot claim an older observation');
    await db.telegramDeliveryIntent.update({ where: { id: 'live-1' }, data: { remoteSentAt: at } });

    for (let n = 2; n <= 101; n += 1) {
      const id = 'active-' + String(n).padStart(3, '0');
      await createOrder(id);
      await createIntent('live-' + n, id);
    }
    start = queries.length;
    result = await resolve(input);
    assert.equal(result.type, 'AMBIGUOUS_ACTIVE_THREADS');
    assert.equal(result.threads.length, 101, 'pagination must not silently drop the last active candidate');
    assert.ok(result.customOrderIds.includes('active-101'));
    assert.equal(queries.slice(start).filter(q => q.query.includes('custom_telegram_current_order_page')).length, 2);
    assert.equal((await resolve({ ...input, agencyId: 'foreign-agency' })).type, 'NO_ACTIVE_THREAD');
    assert.equal((await resolve({ ...input, senderTelegramUserId: '900002' })).type, 'NO_ACTIVE_THREAD');

    // Exercise the actual manual decision and late provider promotion against
    // the installed schema, rather than bypassing the authority with a mock.
    const { reconcileTelegramDeliveryIntent, confirmTelegramDeliveryIntent, settleTelegramDeliveryWithClaim } = require('../../src/services/telegram-delivery-authority-service');
    const member = await db.agencyMember.findUnique({ where: { id: 'member-' + s.agencyId } });
    const secret = crypto.randomBytes(32).toString('base64url');
    await createOrder('promotion-order');
    await createIntent('promotion-intent', 'promotion-order', {
      state: 'RECONCILE_REQUIRED', confirmationAuthority: null, remoteMessageId: null, remoteSentAt: null, confirmedAt: null,
      payload: { recipientTelegramUserId: '900001', text: 'task' }, deviceId: 'original-device', userId: s.userId, memberId: member.id,
      accessEpoch: member.accessEpoch, claimRevision: 1, commitStartedAt: at,
      claimTokenHash: crypto.createHash('sha256').update('telegram-delivery-claim\0' + secret).digest('hex'),
    });
    const manual = await reconcileTelegramDeliveryIntent({ agencyId: s.agencyId, member, intentId: 'promotion-intent',
      resolution: 'CONFIRMED', remoteMessageId: 200001, remoteRecipientTelegramUserId: '900001', remoteSentAt: at,
      reason: 'controlled manual history review', now: at, db });
    assert.equal(manual.intent.confirmationAuthority, 'MANUAL_RECONCILIATION');
    const beforePromotion = await db.telegramDeliveryIntent.findUnique({ where: { id: 'promotion-intent' } });
    const providerProof = { agencyId: s.agencyId, member, intentId: 'promotion-intent', deviceId: 'original-device', claimToken: secret,
      remoteMessageId: 200001, remoteRecipientTelegramUserId: '900001', remoteSentAt: new Date(at.getTime() - 1000), db };
    await assert.rejects(confirmTelegramDeliveryIntent({ ...providerProof, claimToken: 'public-message-fields-are-not-a-capability' }), { code: 'TELEGRAM_DELIVERY_COMMIT_LEASE_STALE' });
    assert.deepEqual(await db.telegramDeliveryIntent.findUnique({ where: { id: 'promotion-intent' } }), beforePromotion);
    const settled = await settleTelegramDeliveryWithClaim({ ...providerProof, creatorId: s.creatorId, accountId: 'telegram-a', kind: 'TASK', outcome: 'CONFIRMED' });
    assert.deepEqual(Object.keys(settled).sort(), ['idempotent', 'intentId', 'ok', 'state']);
    const promoted = await db.telegramDeliveryIntent.findUnique({ where: { id: 'promotion-intent' } });
    assert.equal(promoted.confirmationAuthority, 'PROVIDER_RECEIPT');
    assert.equal(promoted.remoteSentAt.getTime(), at.getTime() - 1000, 'actual provider time replaces the earlier manual estimate');
    assert.equal((await settleTelegramDeliveryWithClaim({ ...providerProof, creatorId: s.creatorId, accountId: 'telegram-a', kind: 'TASK', outcome: 'CONFIRMED' })).idempotent, true);

    const contract = await require('../../src/services/database-contract-service').readDatabaseContract(db);
    assert.equal(contract.ready, true, JSON.stringify(contract));
    const report = {
      passed: true, nativePostgres: !!runtime.native, historyRows: 10000,
      emptyActiveDiscoveryQueries: discovery.length, activeCandidates: result.threads.length,
      currentPageSize: CURRENT_THREAD_PAGE_SIZE, historicalReplyPreserved: true,
      provenanceAndTimeGuards: true, isolationGuards: true, contractReady: contract.ready,
      realManualDecisionAndProviderPromotion: true,
      discoveryPlan: nodes.map(node => ({ type: node['Node Type'], relation: node['Relation Name'], index: node['Index Name'], rows: node['Actual Rows'], loops: node['Actual Loops'] })),
    };
    if (process.env.ONLINOD_TELEGRAM_PROOF_OUTPUT) fs.writeFileSync(process.env.ONLINOD_TELEGRAM_PROOF_OUTPUT, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await require('../../src/prisma').$disconnect();
    await runtime.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
