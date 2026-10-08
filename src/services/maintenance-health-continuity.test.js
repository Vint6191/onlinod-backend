'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), { createRequire } = require('node:module');
const entry = path.join(__dirname, 'job-scheduler.js'), original = createRequire(entry);
require.cache[require.resolve('../prisma')] = { exports: {} };
const registry = require('./maintenance-lane-registry');
function scheduler({ callbacks, selected } = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', fs.readFileSync(entry, 'utf8'))(name => {
    if (callbacks && name === './maintenance-lane-registry') return { ...registry, resolveMaintenanceLanes: () => new Map(Object.entries(callbacks)) };
    if (callbacks && name === './phase2-maintenance-admission-service') return { selectPhase2MaintenanceLanes: async () => ({ ok: true, generation: registry.MAINTENANCE_ADMISSION_GENERATION, selected: selected || Object.keys(callbacks) }) };
    return original(name);
  }, module, module.exports);
  const value = module.exports;
  return { ...value, record: value._test.handleMaintenanceTickResult, snapshot: () => value.getRecurringSchedulerHealthSnapshot().maintenance };
}
const fail = (name, reason = 'FIXTURE_FAILURE') => ({ ok: false, [name]: { ok: false, failed: 1, reason } });
const pass = name => ({ ok: true, [name]: { ok: true, processed: 1 } });

test('an unrelated healthy maintenance batch cannot erase the notification repair failure', () => {
  const s = scheduler(); s.record(fail('notificationHistoryRepair', 'BAD_TRAFFIC_DIRTY_INPUT'));
  s.record(pass('messageLibraryTrash'));
  assert.equal(s.snapshot().status, 'DEGRADED'); assert.equal(s.snapshot().lastReason, 'notificationHistoryRepair:BAD_TRAFFIC_DIRTY_INPUT');
});
test('an empty aggregate result is not proof that a failed lane recovered', () => {
  const s = scheduler(); s.record(fail('notificationHistoryRepair')); s.record({ ok: true });
  assert.equal(s.snapshot().status, 'DEGRADED');
});
for (const reason of ['lease_held', 'not_due', 'domain_work_dependency_wake_bridge_transition']) {
  test(`skipped ${reason} cannot erase the last actual failure of that lane`, () => {
    const s = scheduler(); s.record(fail('notificationHistoryRepair'));
    s.record({ ok: true, notificationHistoryRepair: { ok: true, skipped: true, reason } });
    assert.equal(s.snapshot().status, 'DEGRADED');
  });
}
test('each failed lane needs its own recovery; one successful retry does not clear another', () => {
  const s = scheduler(); s.record({ ok: false, ...fail('notificationHistoryRepair'), ...fail('trafficProjection') });
  s.record(pass('notificationHistoryRepair')); assert.equal(s.snapshot().status, 'DEGRADED'); assert.equal(s.snapshot().lastReason, 'trafficProjection:FIXTURE_FAILURE');
  s.record(pass('trafficProjection')); assert.equal(s.snapshot().status, 'HEALTHY'); assert.equal(s.snapshot().lastReason, null);
});
test('admission failure persists until a subsequent successful admission is actually present', () => {
  const s = scheduler(); s.record(null, Object.assign(new Error('catalog'), { code: 'MAINTENANCE_ADMISSION_SCHEMA_CATALOG_MISMATCH' }));
  s.record(pass('notificationHistoryRepair')); assert.equal(s.snapshot().status, 'DEGRADED');
  s.record({ ok: true, admission: { ok: true, generation: registry.MAINTENANCE_ADMISSION_GENERATION, selected: [] } });
  assert.equal(s.snapshot().status, 'HEALTHY');
});
test('local overlap has no new evidence and preserves the complete health snapshot', () => {
  const s = scheduler(); s.record(fail('notificationHistoryRepair')); const before = s.snapshot();
  s.record({ ok: true, skipped: true, reason: 'local_overlap' }); assert.deepEqual(s.snapshot(), before);
});
test('scheduler diagnostic counts array errors as errors, never NaN/null', () => {
  const s = scheduler(), result = { ok: false, notificationConsequences: { ok: false, errors: ['a', 'b'] } };
  const details = s._test.maintenanceDegradedDetails(result).notificationConsequences;
  assert.equal(details.errors, 2); assert.match(JSON.stringify(details), /"errors":2/);
});
test('actual pump preserves a thrown error code and still attempts later admitted lanes', async () => {
  const calls = [], s = scheduler({ callbacks: {
    notificationHistoryRepair: async () => { calls.push('repair'); throw Object.assign(new Error('fixture failure detail'), { code: 'NOTIFICATION_HISTORY_CURSOR_INVALID' }); },
    messageLibraryTrash: async () => { calls.push('trash'); return { ok: true }; },
  } });
  const result = await s.runPhase2MaintenancePump({ db: {} });
  assert.deepEqual(calls, ['repair', 'trash']); assert.equal(result.ok, false);
  assert.equal(result.notificationHistoryRepair.reason, 'NOTIFICATION_HISTORY_CURSOR_INVALID');
  s.record(result); assert.equal(s.snapshot().lastReason, 'notificationHistoryRepair:NOTIFICATION_HISTORY_CURSOR_INVALID');
});
