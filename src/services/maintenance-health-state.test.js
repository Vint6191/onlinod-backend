'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createMaintenanceHealth, maintenanceDegradedDetails } = require('./maintenance-health-service');
const { MAINTENANCE_LANE_NAMES } = require('./maintenance-lane-registry');
const repair = 'notificationHistoryRepair';
const failure = { ok: false, [repair]: { ok: false, reason: 'BAD_TRAFFIC_DIRTY_INPUT' } };

test('new process starts UNKNOWN and reports only observed local evidence', () => {
  const health = createMaintenanceHealth(), snapshot = health.snapshot();
  assert.equal(snapshot.status, 'UNKNOWN'); assert.equal(snapshot.scope, 'PROCESS_OBSERVED_LANES');
  assert.equal(snapshot.observedLanes, 0); assert.equal(snapshot.totalLanes, MAINTENANCE_LANE_NAMES.length);
  health.record({ ok: true }); assert.deepEqual(health.snapshot(), snapshot);
});
test('10000 mixed updates keep fixed registry storage and cannot hide one failed class', () => {
  const health = createMaintenanceHealth(); health.record(failure);
  for (let i = 0; i < 10000; i++) {
    const name = MAINTENANCE_LANE_NAMES[i % MAINTENANCE_LANE_NAMES.length];
    health.record({ ok: true, [name]: name === repair ? { ok: true, skipped: true, reason: 'not_due' } : { ok: true }, ['unregistered-' + i]: { ok: true } });
  }
  const snapshot = health.snapshot(); assert.equal(snapshot.status, 'DEGRADED');
  assert.equal(snapshot.lanes.length, MAINTENANCE_LANE_NAMES.length);
  assert.deepEqual(snapshot.lanes.map(row => row.name), MAINTENANCE_LANE_NAMES);
  assert.equal(snapshot.observedLanes, MAINTENANCE_LANE_NAMES.length);
});
test('snapshot mutation cannot alter retained health and recovery retains diagnostic timestamps', () => {
  let time = '2026-10-08T00:00:00Z'; const health = createMaintenanceHealth({ now: () => time });
  health.record(failure); const snapshot = health.snapshot(); snapshot.lanes.find(row => row.name === repair).lastReason = 'forged'; snapshot.lanes.length = 0;
  assert.match(health.snapshot().lastReason, /BAD_TRAFFIC_DIRTY_INPUT/);
  time = '2026-10-08T00:01:00Z'; health.record({ ok: true, [repair]: { ok: true, processed: 0 } });
  const row = health.snapshot().lanes.find(row => row.name === repair);
  assert.equal(row.status, 'HEALTHY'); assert.equal(row.lastFailedAt, '2026-10-08T00:00:00Z'); assert.equal(row.lastHealthyAt, time);
});
test('canonical completed generation can recover even if this replica did not execute it', () => {
  const health = createMaintenanceHealth(); health.record(failure);
  health.record({ ok: true, [repair]: { skipped: true, reason: 'generation_complete', completedAt: 'invalid' } });
  assert.equal(health.snapshot().status, 'DEGRADED');
  health.record({ ok: true, [repair]: { skipped: true, reason: 'generation_complete', completedAt: new Date() } });
  assert.equal(health.snapshot().status, 'HEALTHY');
});
test('not-due after a failed maintenance lease is not a successful retry', () => {
  const health = createMaintenanceHealth(); health.record(failure);
  health.record({ ok: true, [repair]: { acquired: false, skipped: true, reason: 'not_due', nextRunAt: new Date(Date.now() + 60000) } });
  assert.equal(health.snapshot().status, 'DEGRADED');
  health.record({ ok: true, [repair]: { acquired: true, skipped: false, complete: false, selected: 0 } });
  assert.equal(health.snapshot().status, 'HEALTHY');
});
test('failed skipped result remains degraded and later valid admission does not erase a lane failure', () => {
  const health = createMaintenanceHealth(); health.record({ ok: false, [repair]: { ok: false, skipped: true, reason: 'domain_work_claim_topology_building' } });
  health.record({ ok: true, admission: { ok: true, selected: [] } });
  assert.equal(health.snapshot().status, 'DEGRADED'); assert.match(health.snapshot().lastReason, /domain_work_claim_topology_building/);
});
test('anonymous pump failure is retained without adding arbitrary class names', () => {
  const health = createMaintenanceHealth(); health.record({ ok: false, unknownClass: { ok: false } });
  assert.equal(health.snapshot().admissionFailure, 'maintenance_pump_failed');
  health.record({ ok: true }); assert.equal(health.snapshot().status, 'DEGRADED');
  health.record({ ok: true, admission: { ok: true } }); assert.equal(health.snapshot().status, 'HEALTHY');
});
test('diagnostic counts and samples remain finite and bounded', () => {
  const details = maintenanceDegradedDetails({ lane: { ok: false, reason: 'r'.repeat(500), error: 'e'.repeat(1000),
    failed: NaN, errors: ['one', 'two'], contended: -1, poisonedSignals: Infinity,
    errorDetails: Array(50).fill({ code: 'fixture' }), poisonedSample: Array(50).fill('fixture'),
  } }).lane;
  assert.equal(details.reason.length, 240); assert.equal(details.error.length, 500);
  assert.equal(details.failed, 0); assert.equal(details.errors, 2); assert.equal(details.contended, 0); assert.equal(details.poisonedSignals, 0);
  assert.equal(details.errorDetails.length, 5); assert.equal(details.poisonedSample.length, 5);
});
