const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const devicesRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'devices.js'), 'utf8');

function segment(startNeedle, endNeedle) {
  const start = devicesRoute.indexOf(startNeedle);
  assert.ok(start >= 0, `missing ${startNeedle}`);
  const end = devicesRoute.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `missing ${endNeedle}`);
  return devicesRoute.slice(start, end);
}

test('V20.17 heartbeat canonical manifest is authorized by creator scope, not DeviceCreatorBinding', () => {
  const heartbeat = segment('router.post("/heartbeat"', '// Legacy endpoint intentionally cannot mutate realtime coverage.');
  assert.match(devicesRoute, /allowedCreatorScope/);
  assert.match(heartbeat, /const manifestRows = await withHeartbeatMemberGeneration\(\{/);
  assert.match(heartbeat, /work: async \(\{ tx, member \}\) => \{[\s\S]*allowedCreatorScope\(\{ agencyId, member, db: tx \}\)/);
  assert.match(heartbeat, /requestedCreatorIds\.filter\(\(id\) => manifestAllowedCreatorIds\.has\(id\)\)/);

  const manifest = segment('// Revision correctness is state-based.', 'return res.json({');
  assert.doesNotMatch(manifest, /deviceCreatorBinding\.(find|findMany|findFirst)/i,
    'runtime observation binding must never authorize credential/session manifest access');
});

test('V20.17 heartbeat manifest projects only non-secret canonical metadata', () => {
  const manifest = segment('// Revision correctness is state-based.', 'return res.json({');
  assert.match(manifest, /sessionState:\s*\{\s*select:/s);
  for (const field of ['status', 'revision', 'payloadVersion', 'platformUserId', 'capturedByDeviceId', 'updatedAt']) {
    assert.match(manifest, new RegExp(`${field}: true`));
  }
  assert.doesNotMatch(manifest, /encryptedPayload\s*:\s*true|\biv\s*:\s*true|\btag\s*:\s*true|credentialHash\s*:\s*true|coherenceHash\s*:\s*true|cookies\s*:\s*true/);
});

test('V20.17 heartbeat returns current state as correctness source while commands remain hints', () => {
  const heartbeat = segment('router.post("/heartbeat"', '// Legacy endpoint intentionally cannot mutate realtime coverage.');
  assert.match(heartbeat, /Revision correctness is state-based/);
  assert.match(heartbeat, /DeviceCommand remains only a wakeup/);
  assert.match(heartbeat, /creatorSessions,/);
  assert.match(heartbeat, /status: creator\.sessionState\?\.status \|\| "MISSING"/);
  assert.match(heartbeat, /revision: creator\.sessionState\?\.revision \|\| 0/);
});

test('V20.17 cross-agency device mutation and manifest are both generation-fenced', () => {
  const heartbeat = segment('router.post("/heartbeat"', '// Legacy endpoint intentionally cannot mutate realtime coverage.');
  const capabilityAt = heartbeat.indexOf('const capabilityCommit = await withHeartbeatMemberGeneration');
  const deviceAt = heartbeat.indexOf('tx.workerDevice.upsert', capabilityAt);
  const manifestAt = heartbeat.indexOf('const manifestRows = await withHeartbeatMemberGeneration', deviceAt);
  const scopeAt = heartbeat.indexOf('allowedCreatorScope({ agencyId, member, db: tx })', manifestAt);
  assert.ok(capabilityAt >= 0 && deviceAt > capabilityAt,
    'target-agency device row may mutate only after current membership is locked and reread');
  assert.ok(manifestAt > deviceAt && scopeAt > manifestAt,
    'manifest authorization must be re-resolved under a current member generation');
});
