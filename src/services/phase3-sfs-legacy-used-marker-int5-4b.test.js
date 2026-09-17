const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.resolve(__dirname, '../../prisma/migrations/20260916230000_phase3_sfs_legacy_used_marker_repair/migration.sql'),
  'utf8',
);

test('INT5.4B legacy sfs_used_marker remains durable oneTargetForever proof after mixed-history convergence', () => {
  assert.match(migration, /JOIN "AutomationJob" j/);
  assert.match(migration, /j\."type" = 'sfs_hunter'/);
  assert.match(migration, /j\."action" = 'sfs_used_marker'/);
  assert.match(migration, /j\."status" = 'done'/);
  assert.match(migration, /j\."agencyId" = c\."agencyId"/);
  assert.match(migration, /j\."creatorId" = c\."creatorId"/);
  assert.match(migration, /j\."payload"->>'targetUserId'.*= c\."targetUserId"/s);
  assert.match(migration, /"usedForever" = true/);
  assert.match(migration, /'historicalConsumptionProofKind', 'LEGACY_SFS_USED_MARKER'/);
});

test('INT5.4B legacy consumption repair is forward-only and does not overwrite live SFS workflow state', () => {
  const update = migration.slice(migration.indexOf('UPDATE "SfsTargetCandidate"'));
  assert.doesNotMatch(update, /"state"\s*=/);
  assert.doesNotMatch(update, /"phase"\s*=/);
  assert.doesNotMatch(update, /INSERT INTO "AutomationDelivery"/);
  assert.match(update, /c\."usedForever" IS DISTINCT FROM true/);
});
