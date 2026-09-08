"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function fakeDb(initial = null, currentMember = null) {
  let row = { id: "creator-1", agencyId: "agency-1", deletedAt: null, customsVaultFolderId: initial, updatedAt: new Date("2026-08-21T12:00:00.000Z") };
  const canonicalMember = currentMember || member;
  const db = {
    $executeRawUnsafe: async (sql) => { assert.match(String(sql), /pg_advisory_xact_lock/); return 0; },
    // Production Custom management writes now join the Agency lifecycle fence before
    // the member/scope fence. Keep this fake production-shaped instead of bypassing
    // the new lock-order authority.
    agency: {
      findFirst: async ({ where }) => String(where.id) === "agency-1"
        ? { id: "agency-1", deletedAt: null, status: "ACTIVE" }
        : null,
    },
    agencyMemberCreator: { findFirst: async () => ({ id: "scope-1" }) },
    agencyMember: {
      findFirst: async ({ where }) => String(where.id) === String(canonicalMember.id) && String(where.userId) === String(canonicalMember.userId) && String(where.agencyId) === String(canonicalMember.agencyId) ? { ...canonicalMember } : null,
    },
    creatorAccount: {
      findFirst: async ({ where }) => row && where.id === row.id && where.agencyId === row.agencyId ? { ...row } : null,
      updateMany: async ({ where, data }) => {
        if (!row || where.id !== row.id || where.agencyId !== row.agencyId || (where.updatedAt && +new Date(where.updatedAt) !== +row.updatedAt)) return { count: 0 };
        row = { ...row, ...data, updatedAt: new Date(row.updatedAt.getTime() + 1) }; return { count: 1 };
      },
    },
    _row: () => row,
    async $transaction(fn) { return fn(this); },
  };
  return db;
}
const member = { id: "member-1", userId: "user-1", agencyId: "agency-1", roleKey: "OWNER", role: "OWNER", assignedCreators: "all", accessEpoch: 1, permissions: { "content.manage_vault": true } };

test("Customs Vault destination schema is one compact creator-scoped folder id", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const block = schema.match(/model CreatorAccount \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(block, /customsVaultFolderId\s+String\?/);
  assert.doesNotMatch(block, /customsVaultFolderName|customsVaultFolderStatus|customsVaultFolderUpdatedAt/);
});

test("get/set stores only the folder id and supports explicit clear", async () => {
  const { getCustomVaultDestination, setCustomVaultDestination } = require("./custom-vault-destination-service");
  const db = fakeDb();
  const empty = await getCustomVaultDestination({ agencyId: "agency-1", member, creatorId: "creator-1", db });
  assert.deepEqual(empty, { ok: true, creatorId: "creator-1", folderId: null, configured: false });
  const saved = await setCustomVaultDestination({ agencyId: "agency-1", member, creatorId: "creator-1", folderId: "987654", db });
  assert.equal(saved.folderId, "987654"); assert.equal(db._row().customsVaultFolderId, "987654");
  const cleared = await setCustomVaultDestination({ agencyId: "agency-1", member, creatorId: "creator-1", folderId: null, db });
  assert.equal(cleared.folderId, null); assert.equal(cleared.configured, false);
});

test("system pseudo folders are never accepted as Customs destination", async () => {
  const { setCustomVaultDestination } = require("./custom-vault-destination-service");
  for (const value of ["all", "Unsorted", " ALL "]) {
    await assert.rejects(() => setCustomVaultDestination({ agencyId: "agency-1", member, creatorId: "creator-1", folderId: value, db: fakeDb() }), /custom Vault folder/i);
  }
});

test("commit-time Vault destination update rejects a stale management actor and preserves the creator default", async () => {
  const { setCustomVaultDestination } = require("./custom-vault-destination-service");
  const staleCurrent = { ...member, accessEpoch: 2, assignedCreators: [] };
  const db = fakeDb("old-folder", staleCurrent);
  await assert.rejects(
    () => setCustomVaultDestination({ agencyId: "agency-1", member, creatorId: "creator-1", folderId: "new-folder", db }),
    (error) => error?.code === "CUSTOM_MANAGEMENT_ACCESS_STALE" && error?.status === 409,
  );
  assert.equal(db._row().customsVaultFolderId, "old-folder");
});
