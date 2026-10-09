'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

test('Automation queue returns outcome evidence and retains origin, scope and pagination filters', async () => {
  let captured;
  const delivery = { id: 'send', status: 'FAILED', failureCategory: 'OUTCOME_UNKNOWN_RECONCILE', reportedFailureCategory: 'TERMINAL', writeCommitAt: '2026-10-09T00:00:00Z', writeCommitRevision: 7 };
  const prisma = { automationDelivery: {
    async findMany(input) { captured = input; return [Object.fromEntries(Object.keys(input.select).filter(key => key in delivery).map(key => [key, delivery[key]]))]; },
    async count() { return 21; },
  } };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('./automation-action-delivery-service'), 'utf8'), {
    module, exports: module.exports, console, require: name => name === '../prisma' ? prisma : name === 'node:crypto' ? require(name) : {},
  });
  const response = await module.exports.listActionDeliveries({ agencyId: 'agency', creatorIds: ['a'], status: 'FAILED', offset: 20, limit: 1 });
  assert.equal(response.items[0].failureCategory, 'OUTCOME_UNKNOWN_RECONCILE');
  assert.equal(response.items[0].writeCommitRevision, 7);
  assert.equal(response.items[0].reportedFailureCategory, 'TERMINAL');
  assert.equal(captured.where.originKind, 'AUTOMATION');
  assert.equal(captured.where.agencyId, 'agency');
  assert.equal(captured.where.creatorId.in[0], 'a');
  assert.equal(captured.where.status, 'FAILED');
  assert.equal(captured.skip, 20); assert.equal(captured.take, 1);
  assert.equal(response.count, 21); assert.equal(response.nextOffset, 21); assert.equal(response.hasMore, false);
});
