"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function fakeDb(initial = null) {
  let row = { id: "creator-1", agencyId: "agency-1", deletedAt: null, customsVaultFolderId: initial, updatedAt: new Date("2026-08-21T12:00:00.000Z") };
  return {
    agencyMemberCreator: { findFirst: async () => ({ id: "scope-1" }) },
    creatorAccount: {
      findFirst: async ({ where }) => row && where.id === row.id && where.agencyId === row.agencyId ? { ...row } : null,
      updateMany: async ({ where, data }) => {
        if (!row || where.id !== row.id || where.agencyId !== row.agencyId || (where.updatedAt && +new Date(where.updatedAt) !== +row.updatedAt)) return { count: 0 };
        row = { ...row, ...data, updatedAt: new Date(row.updatedAt.getTime() + 1) }; return { count: 1 };
      },
    },
    _row: () => row,
  };
}
const member = { id: "member-1", userId: "user-1", roleKey: "OWNER" };

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
