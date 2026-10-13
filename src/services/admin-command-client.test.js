"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");
const source = fs.readFileSync(path.join(__dirname, "../../public/admin/core/admin-command-client.js"), "utf8");
function browser(storage = new Map(), fetch = async () => { throw Error("network lost"); }) {
  const window = {};
  const sandbox = { window, crypto: webcrypto, TextEncoder, fetch, sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } };
  vm.runInNewContext(source, sandbox);
  return { window, commands: window.NodAdminCommands, storage };
}
const input = { path: "/api/admin/billing/creator/creator-a", method: "PATCH", body: { expectedRevision: 1, corePriceCents: 3200, reason: "Edit" }, token: "bearer-sensitive-value" };
test("network uncertainty and browser reload retain the exact command identity", async () => {
  const a = browser(); const first = await a.commands.prepare(input);
  const b = browser(a.storage); const retry = await b.commands.prepare(input);
  assert.equal(first.commandId, retry.commandId);
  const alias = await b.commands.prepare({ ...input, path: "/api/admin/creators/creator-a/billing" });
  assert.equal(first.commandId, alias.commandId);
  assert.doesNotMatch(JSON.stringify([...a.storage]), /bearer-sensitive-value|corePriceCents|3200/);
});
test("editing an unresolved intent is blocked until its known result is retrieved", async () => {
  const b = browser(new Map(), async url => ({ ok: true, json: async () => ({ ok: true, commandId: url.split("/").pop(), status: "SUCCEEDED" }) }));
  const first = await b.commands.prepare(input);
  const changed = { ...input, body: { ...input.body, corePriceCents: 5000 } };
  const blocked = await b.commands.prepare(changed);
  assert.equal(blocked.blocked, true); assert.equal(blocked.commandId, first.commandId);
  const result = await b.commands.resolve(input.path, input.method, input.token);
  assert.equal(result.pending, false);
  assert.notEqual((await b.commands.prepare(changed)).commandId, first.commandId);
});
test("truncated response and 500 preserve identity; durable success settles it", async () => {
  const b = browser(); const first = await b.commands.prepare(input);
  b.commands.settle(first, { status: 200 }, { ok: false, code: "INVALID_JSON" });
  assert.equal((await b.commands.prepare(input)).commandId, first.commandId);
  b.commands.settle(first, { status: 500 }, { ok: false, code: "INTERNAL" });
  assert.equal((await b.commands.prepare(input)).commandId, first.commandId);
  b.commands.settle(first, { status: 200 }, { ok: true, commandId: first.commandId });
  assert.notEqual((await b.commands.prepare(input)).commandId, first.commandId);
});
test("debug redaction removes nested login/reset/token secrets", () => {
  const b = browser();
  const safe = b.commands.redact({ request: { body: { password: "private" } }, response: { token: "private", admin: { passwordHash: "private" }, tempPassword: "private" } });
  assert.doesNotMatch(JSON.stringify(safe), /private/);
});
test("unmigrated actions do not pretend to have durable command receipts", async () => {
  const b = browser(); assert.equal(await b.commands.prepare({ ...input, path: "/api/admin/unknown-legacy-action" }), null);
});

test("policy, support hold and entitlement mutations preserve UUID across browser reload", async () => {
  for (const path of ["/api/admin/agencies/a/subscription", "/api/admin/agencies/a/billing-hold", "/api/admin/creators/c/entitlement"]) {
    const b = browser(); const first = await b.commands.prepare({ ...input, path });
    assert.ok(first.commandId);
    assert.equal((await browser(b.storage).commands.prepare({ ...input, path })).commandId, first.commandId);
  }
});

test("bulk acceptance survives network uncertainty and resolves independently of completion", async () => {
  const payload = { ...input, method: "POST", path: "/api/admin/billing/agency/a/apply-tier", body: { tier: "PRO", reason: "Bulk", items: [{ creatorId: "c", expectedRevision: 1 }] } };
  const b = browser(new Map(), async url => ({ ok: true, json: async () => ({ ok: true, commandId: url.split("/").pop(), status: "RUNNING", result: { accepted: true } }) }));
  const first = await b.commands.prepare(payload);
  assert.ok(first.commandId);
  assert.equal((await browser(b.storage).commands.prepare(payload)).commandId, first.commandId);
  const resolved = await b.commands.resolve(payload.path, "POST", payload.token);
  assert.equal(resolved.pending, false);
  assert.equal(resolved.status, "RUNNING");
});

test("archive command retains UUID on unknown response and blocks a changed selection", async () => {
 const payload={...input,method:"POST",path:"/api/admin/data/creators/c/archive-deliveries",body:{agencyId:"a",reason:"archive",olderThan:"2026-01-01T00:00:00Z",items:[{id:"d",expectedUpdatedAt:"2025-01-01T00:00:00Z"}]}};
 const b=browser();const first=await b.commands.prepare(payload);assert.ok(first.commandId);
 b.commands.settle(first,{status:502},{ok:false});assert.equal((await browser(b.storage).commands.prepare(payload)).commandId,first.commandId);
 assert.equal((await b.commands.prepare({...payload,body:{...payload.body,reason:"changed"}})).blocked,true);
});


test("operational commands retain stable UUID across reload, including DELETE bodies",async()=>{
 for(const [method,path] of [["PATCH","/api/admin/agencies/a"],["DELETE","/api/admin/agencies/a"],["PATCH","/api/admin/members/m/role"],["DELETE","/api/admin/members/m"],["POST","/api/admin/users/u/reset-password"],["POST","/api/admin/devices/d/kick"]]){
  const b=browser(),request={...input,method,path,body:{reason:"explicit",expectedUpdatedAt:"2026-01-01T00:00:00Z"}};const first=await b.commands.prepare(request);assert.ok(first.commandId);assert.equal((await browser(b.storage).commands.prepare(request)).commandId,first.commandId);assert.equal((await b.commands.prepare({...request,body:{...request.body,reason:"changed"}})).blocked,true);
 }
});

 test("all retention commands retain UUID across reload and unknown outcome", async () => {
 for (const [path,method] of [["/api/admin/system/retention","PATCH"],["/api/admin/system/retention/reset","POST"],["/api/admin/system/retention/run","POST"]]) {
   const b=browser(), request={...input,path,method}; const first=await b.commands.prepare(request);
   assert.ok(first.commandId);assert.equal((await browser(b.storage).commands.prepare(request)).commandId,first.commandId);
 }
});

test("global commercial policy uses a stable command identity and blocks changed retry intent", async () => {
  const b = browser();
  const args = { ...input, path: "/api/admin/billing/commercial-policy", body: { expectedRevision: 3, settings: { trialDays: 14 }, reason: "Global pricing" } };
  const first = await b.commands.prepare(args);
  assert.ok(first.commandId);
  assert.equal((await browser(b.storage).commands.prepare(args)).commandId, first.commandId);
  assert.equal((await b.commands.prepare({ ...args, body: { ...args.body, expectedRevision: 4 } })).blocked, true);
});

test("concurrent preparations reserve one command identity before either request can send", async () => {
  const b = browser(); b.window.NodAdminState = { admin: { id: "admin-one" } };
  const attempts = await Promise.all(Array.from({ length: 8 }, () => b.commands.prepare(input)));
  assert.equal(new Set(attempts.map(item => item.commandId)).size, 1);
  // Promise.all preserves invocation order; WebCrypto digests can complete in
  // another order. Assert every reservation and the final durable counter.
  assert.deepEqual(attempts.map(item => item.attempts).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(b.storage.size, 1);
  assert.equal(JSON.parse([...b.storage.values()][0]).attempts, 8);
});

test("pending results are visible only to their administrator and remain resolvable after sign-in", async () => {
  const b = browser(new Map(), async url => ({ ok: true, json: async () => ({ ok: true, commandId: url.split('/').pop(), status: "SUCCEEDED" }) }));
  b.window.NodAdminState = { admin: { id: "admin-one" } };
  const first = await b.commands.prepare(input);
  assert.equal((await b.commands.pending(input.token)).length, 1);
  b.window.NodAdminState.admin.id = "admin-two";
  assert.equal((await b.commands.pending("other-token")).length, 0);
  b.window.NodAdminState.admin.id = "admin-one";
  assert.equal((await b.commands.pending("new-token"))[0].commandId, first.commandId);
  assert.equal((await b.commands.prepare({ ...input, token: "new-token" })).blocked, true);
  assert.equal((await b.commands.resolve(input.path, input.method, "new-token")).pending, false);
});

test("an existing session-keyed command is adopted without changing its UUID", async () => {
  const b = browser(); const previous = await b.commands.prepare(input);
  b.window.NodAdminState = { admin: { id: "admin-one" } };
  const next = await b.commands.prepare(input);
  assert.equal(next.commandId, previous.commandId);
  assert.equal((await b.commands.pending(input.token)).length, 1);
  assert.equal(b.storage.size, 1);
});

test("recovery metadata never stores password inputs or bearer credentials", async () => {
  const b = browser(); b.window.NodAdminState = { admin: { id: "admin-one" } };
  await b.commands.prepare({ ...input, method: "POST", path: "/api/admin/admin-users/id/reset-password", body: { password: "sensitive-test-password", expectedEpoch: 7, reason: "private reason" } });
  assert.doesNotMatch(JSON.stringify([...b.storage]), /sensitive-test-password|bearer-sensitive-value|private reason/);
});
