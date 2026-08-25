const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

test('V20.22.1 npm start/dev regenerate Prisma Client from current schema', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts?.prestart, 'prisma generate');
  assert.equal(pkg.scripts?.predev, 'prisma generate');
  assert.equal(pkg.scripts?.postinstall, 'prisma generate');
});

test('V20.22.1 generated Prisma Client is guarded against pre-cutover CreatorAccount shape', () => {
  const prismaJs = read('src/prisma.js');
  assert.match(prismaJs, /Prisma\?\.dmmf\?\.datamodel\?\.models/);
  assert.match(prismaJs, /PRISMA_CLIENT_SCHEMA_STALE/);
  assert.match(prismaJs, /\["partition", "sessionMode"\]/);
  assert.match(prismaJs, /\["sessionState", "networkProfile"\]/);
});

test('V20.22.1 current Prisma schema and creators route have no CreatorAccount.partition contract', () => {
  const schema = read('prisma/schema.prisma');
  const creator = schema.match(/model CreatorAccount \{([\s\S]*?)\n\}/);
  assert.ok(creator, 'CreatorAccount model must exist');
  assert.doesNotMatch(creator[1], /^\s*partition\s+/m);
  assert.doesNotMatch(creator[1], /^\s*sessionMode\s+/m);
  assert.match(creator[1], /^\s*sessionState\s+/m);
  assert.match(creator[1], /^\s*networkProfile\s+/m);

  const route = read('src/routes/creators.js');
  assert.doesNotMatch(route, /\bpartition\s*:/, 'creator HTTP payload/response contract must not reintroduce partition');
  assert.doesNotMatch(route, /\.partition\b/, 'creator route must not read a partition field');
});
