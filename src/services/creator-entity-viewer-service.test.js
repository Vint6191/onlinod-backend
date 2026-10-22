"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { readWithEntityViewer } = require("./creator-entity-viewer-service");

function fixture() {
  const member = { id:"member",userId:"user",agencyId:"agency",accessEpoch:3,role:"OWNER",assignedCreators:"all" };
  const creator = { id:"creator",agencyId:"agency",deletedAt:null }, calls = [];
  let revoked = false;
  const tx = { agencyMember: { findFirst: async () => { calls.push("snapshot-member"); return member; } },
    creatorAccount: { findFirst: async () => creator } };
  const db = { agencyMember: { findFirst: async () => { calls.push("current-member"); return revoked ? null : member; } },
    creatorAccount: { findFirst: async () => creator },
    async $transaction(work) { return work(tx); } };
  return { calls, tx, db, input:{db,agencyId:"agency",creatorId:"creator",userId:"user",member}, revoke(){revoked=true;} };
}

test("entity read rechecks current membership after its repeatable snapshot before returning payload", async () => {
  const f = fixture();
  const value = await readWithEntityViewer(f.input, ({ db }) => { assert.equal(db,f.tx); return {entities:[]}; });
  assert.deepEqual(value,{entities:[]});
  assert.deepEqual(f.calls,["snapshot-member","current-member"]);
});

test("access revoked while reading rejects the captured entity page", async () => {
  const f = fixture();
  await assert.rejects(() => readWithEntityViewer(f.input, () => { f.revoke(); return {secret:"must not return"}; }), {code:"ENTITY_CHANGE_ACCESS_CHANGED"});
});

test("retention reconciliation metadata also rechecks current access before leaving the snapshot", async () => {
  const f = fixture();
  await assert.rejects(() => readWithEntityViewer(f.input, () => {
    f.revoke(); throw Object.assign(new Error("expired"),{code:"RECONCILE_REQUIRED",headRevision:"1234"});
  }), {code:"ENTITY_CHANGE_ACCESS_CHANGED"});
});
