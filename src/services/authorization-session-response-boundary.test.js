"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { assertCurrentAuthorizationSession } = require("./authorization-session-authority-service");
const now = new Date("2026-10-12T12:00:00.123Z");
const actor = { userId: "user", agencyId: "agency", deviceId: "device", authorizationSessionId: "login-A" };
function fixture(rows) {
  const queries = [];
  const db = {
    $queryRawUnsafe: async () => [{ authorityNow: now }],
    refreshSession: { findFirst: async query => {
      queries.push(query);
      return rows.find(row => Object.entries(query.where).every(([key,value]) => key === "expiresAt"
        ? row.expiresAt > value.gt : row[key] === value)) || null;
    } },
  };
  return { db, queries };
}
const session = patch => ({ ...actor, id: "refresh-1", revokedAt: null, expiresAt: new Date(now.getTime()+60_000), ...patch });

test("a newer login on the same device cannot authorize a revoked in-flight request", async () => {
  const { db } = fixture([session({ revokedAt: now }), session({ id:"refresh-2", authorizationSessionId:"login-B" })]);
  await assert.rejects(assertCurrentAuthorizationSession({db,...actor}), {code:"SESSION_REVOKED",status:401});
  await assertCurrentAuthorizationSession({db,...actor,authorizationSessionId:"login-B"});
});

test("refresh rotation preserves response authority but another account, agency or device does not", async () => {
  const {db,queries} = fixture([session({ id:"rotated-refresh" })]);
  await assertCurrentAuthorizationSession({db,...actor});
  assert.deepEqual(queries[0].select,{id:true});
  for (const key of ["userId","agencyId","deviceId"]) {
    await assert.rejects(assertCurrentAuthorizationSession({db,...actor,[key]:"different"}),{code:"SESSION_REVOKED"});
  }
});

test("expiry at the database boundary and a missing device fail closed", async () => {
  const {db} = fixture([session({expiresAt:now})]);
  await assert.rejects(assertCurrentAuthorizationSession({db,...actor}),{code:"SESSION_REVOKED"});
  await assert.rejects(assertCurrentAuthorizationSession({db,...actor,deviceId:null}),{code:"SESSION_REVOKED"});
});

test("legacy requests cannot borrow current lineage and a database clock failure stays retryable", async () => {
  const {db} = fixture([session({})]);
  await assert.rejects(assertCurrentAuthorizationSession({db,...actor,authorizationSessionId:null}),{code:"SESSION_REVOKED"});
  db.$queryRawUnsafe=async()=>{throw Error("temporary database failure");};
  await assert.rejects(assertCurrentAuthorizationSession({db,...actor}),{code:"DB_TIME_AUTHORITY_QUERY_FAILED"});
});
