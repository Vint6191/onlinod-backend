"use strict";
const test = require('node:test');
const assert = require('node:assert/strict');
const { listCustomReadyDeliveries } = require('./custom-content-delivery-service');
const { vaultSettlementFingerprint } = require('./custom-content-pipeline-authority-service');

// Explicit Prisma-shaped in-memory adapter. It models row-cursor loss and value
// comparisons; native PostgreSQL locking/concurrency is not claimed by this suite.
function matches(row, where) {
  return Object.entries(where || {}).every(([key, condition]) => {
    if (key === 'AND') return (Array.isArray(condition) ? condition : [condition]).every(x => matches(row, x));
    if (key === 'OR') return condition.some(x => matches(row, x));
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      if ('is' in condition) return row[key] && matches(row[key], condition.is);
      return Object.entries(condition).every(([op, value]) => {
        const current = row[key];
        if (op === 'in') return value.includes(current);
        if (op === 'not') return current !== value;
        if (op === 'gt') return current > value;
        if (op === 'gte') return current >= value;
        if (op === 'lt') return current < value;
        if (op === 'equals') return +current === +value;
        throw new Error(`Unimplemented filter ${op}`);
      });
    }
    return condition instanceof Date ? +row[key] === +condition : row[key] === condition;
  });
}
function fixture(size = 3, poisoned = 0) {
  const rows = [], assets = [], queries = [];
  for (let index = 0; index < size; index++) {
    const id = String(index).padStart(5, '0'), reviewedAt = new Date(1700000000000 + index), mediaId = String(90000 + index);
    const customOrder = { id: `order-${id}`, creatorId: 'creator-1', dialogId: '1234', type: 'CONTENT', status: 'PENDING',
      fanDeliveredAt: null, priceCents: 1000, paidAmountCents: 0, deliveryOfferedCents: 0, deliverySentMediaIds: [], deliveryMessageIds: [] };
    rows.push({ id, agencyId: 'agency-1', creatorId: 'creator-1', customOrderId: customOrder.id, customOrder,
      reviewStatus: 'APPROVED', reviewedAt, pipelineDisposition: 'ACTIVE', telegramMessageIds: [index + 1], ofMediaIds: [mediaId],
      executionVaultFolderId: 'folder-1', executionProfileRevision: 1, executionPinnedAt: reviewedAt,
      vaultSettlementFolderId: 'folder-1', vaultSettlementProfileRevision: 1,
      vaultSettlementMediaFingerprint: vaultSettlementFingerprint({ folderId: 'folder-1', profileRevision: 1, mediaIds: [mediaId] }),
      vaultSettlementConfirmedAt: index < poisoned ? null : reviewedAt, vaultSettlementConfirmedByDeviceId: 'device-1' });
    assets.push({ creatorId: 'creator-1', mediaId, source: 'CUSTOM', customOrderId: customOrder.id, customSubmissionId: id,
      customFullPriceCents: 1000, folderIds: ['folder-1'], sortingStatus: 'SORTED', catalogActive: true });
  }
  const db = {
    creatorAccount: { async findMany({ where }) { return (where.id?.in || ['creator-1']).map(id => ({ id })); } },
    creatorMediaAsset: { async findMany({ where }) { return assets.filter(asset => where.OR.some(group => group.creatorId === asset.creatorId && group.mediaId.in.includes(asset.mediaId))); } },
    customContentSubmission: {
      async findMany(query) {
        queries.push(query); let found = rows.filter(row => matches(row, query.where));
        found.sort((a, b) => +a.reviewedAt - +b.reviewedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        if (query.cursor?.id) {
          const anchor = rows.find(row => row.id === query.cursor.id);
          if (!anchor) return [];
          found = found.filter(row => +row.reviewedAt > +anchor.reviewedAt || (+row.reviewedAt === +anchor.reviewedAt && row.id > anchor.id));
        }
        return found.slice(0, query.take);
      },
      async findFirst({ where }) { return rows.find(row => matches(row, where)) || null; },
    },
  };
  const member = { id: 'member-1', agencyId: 'agency-1', role: 'OPERATOR', roleKey: 'operator', assignedCreators: 'all', permissions: { 'chats.reply': true } };
  const read = extra => listCustomReadyDeliveries({ agencyId: 'agency-1', member, db, ...extra });
  return { rows, queries, assets, db, member, read };
}

test('ready request bounds inspection and empty continuation reaches work beyond 2500 invalid rows', async () => {
  const f = fixture(2501, 2500);
  const first = await f.read({ limit: 1 });
  assert.equal(first.items.length, 0); assert(first.nextCursor); assert(f.queries.length <= 3);
  let cursor = first.nextCursor, found = [], requests = 1;
  while (cursor) { const count = f.queries.length, page = await f.read({ limit: 1, cursor }); requests++;
    assert(f.queries.length - count <= 3); found.push(...page.items); cursor = page.nextCursor;
    assert(requests < 10);
  }
  assert.deepEqual(found.map(x => x.submissionId), ['02500']);
});
for (const change of ['delete', 'move-review-time']) {
  test(`ready value cursor survives anchor ${change}`, async () => {
    const f = fixture(); const first = await f.read({ limit: 1 });
    if (change === 'delete') f.rows.shift(); else f.rows[0].reviewedAt = new Date(1900000000000);
    const second = await f.read({ limit: 1, cursor: first.nextCursor });
    assert.equal(second.items[0]?.submissionId, '00001');
    assert.equal(f.queries.at(-1).cursor, undefined, 'continuation cannot depend on a mutable/deleted row');
  });
}
test('ready keyset breaks equal review timestamps by immutable id without duplicates', async () => {
  const f = fixture(205);
  for (const row of f.rows) row.reviewedAt = new Date(1700000000000);
  let cursor = null, found = [];
  do { const page = await f.read({ limit: 17, cursor }); found.push(...page.items.map(x => x.submissionId)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(found, f.rows.map(x => x.id));
});
for (const change of ['member', 'creator-scope']) {
  test(`ready cursor cannot silently continue under a different ${change}`, async () => {
    const f = fixture(); const first = await f.read({ limit: 1 });
    const member = { ...f.member, ...(change === 'member' ? { id: 'member-2' } : { assignedCreators: ['creator-1'] }) };
    await assert.rejects(f.read({ limit: 1, cursor: first.nextCursor, member }), { code: 'CUSTOM_DELIVERY_CURSOR_STALE' });
  });
}
for (const cursor of ['missing-anchor', 'ready1.not-json', 'x'.repeat(1200)]) {
  test(`invalid ready cursor fails explicitly (${cursor.length > 100 ? 'oversized' : cursor})`, async () => {
    const f = fixture(); await assert.rejects(f.read({ cursor }), error => /^CUSTOM_DELIVERY_CURSOR_/.test(error.code));
    assert.equal(f.queries.length, 0);
  });
}
test('rolling deployment accepts a legacy cursor only after resolving its authorized anchor', async () => {
  const f = fixture(); const page = await f.read({ limit: 1, cursor: '00000' });
  assert.equal(page.items[0].submissionId, '00001');
});
