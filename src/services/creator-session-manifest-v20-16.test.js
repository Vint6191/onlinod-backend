const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const creatorsRoute = fs.readFileSync(path.join(root, 'src', 'routes', 'creators.js'), 'utf8');

function segment(startNeedle, endNeedle) {
  const start = creatorsRoute.indexOf(startNeedle);
  assert.ok(start >= 0, `missing ${startNeedle}`);
  const end = creatorsRoute.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(end > start, `missing ${endNeedle}`);
  return creatorsRoute.slice(start, end);
}

test('V20.16 creator list exposes only safe broker manifest metadata', () => {
  const list = segment('router.get("/",', 'router.post("/",');
  assert.match(list, /sessionState:\s*\{\s*select:/s);
  for (const field of ['status', 'revision', 'payloadVersion', 'platformUserId', 'capturedByDeviceId', 'updatedAt']) {
    assert.match(list, new RegExp(`${field}: true`));
  }
  assert.doesNotMatch(list, /encryptedPayload|\biv:\s*true|\btag:\s*true|credentialHash|coherenceHash/);
});

test('V20.16 single creator read uses the same safe broker manifest projection', () => {
  const read = segment('router.get("/:id"', 'router.patch("/:id/telegram-contact"');
  assert.match(read, /sessionState:\s*\{\s*select:/s);
  assert.match(read, /capturedByDeviceId: true/);
  assert.doesNotMatch(read, /encryptedPayload|\biv:\s*true|\btag:\s*true/);
});
