"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  assertLegacyAccessSnapshotReadable,
  assertLegacyAccessSnapshotWritable,
  countLegacyAccessSnapshotSecrets,
  cryptoShredLegacyAccessSnapshotSecrets,
  cryptoShredLegacyAccessSnapshotById,
} = require("./legacy-access-snapshot-policy");

function policyDb(enforceOpaqueSecrets) {
  const snapshots = [
    { agencyId: "agency-1", encryptedPayload: "one", iv: "iv", tag: "tag", algorithm: "aes-256-gcm", active: true, revokedAt: null, payloadRetiredAt: null },
    { agencyId: "agency-1", encryptedPayload: "two", iv: "iv", tag: "tag", algorithm: "aes-256-gcm", active: false, revokedAt: new Date(), payloadRetiredAt: null },
  ];
  return {
    snapshots,
    db: {
      agencyCryptoRoot: { findUnique: async () => ({ agencyId: "agency-1", version: 1, enforceOpaqueSecrets }) },
      accessSnapshot: {
        count: async () => snapshots.filter((row) => row.encryptedPayload != null).length,
        updateMany: async ({ where = {}, data }) => {
          let count = 0;
          for (const row of snapshots) {
            if (where.id != null && row.id !== where.id) continue;
            if (where.agencyId != null && row.agencyId !== where.agencyId) continue;
            if (where.encryptedPayload?.not === null && row.encryptedPayload == null) continue;
            if (where.active != null && row.active !== where.active) continue;
            if (Object.prototype.hasOwnProperty.call(where, "revokedAt") && where.revokedAt === null && row.revokedAt !== null) continue;
            if (Object.prototype.hasOwnProperty.call(where, "payloadRetiredAt") && where.payloadRetiredAt === null && row.payloadRetiredAt !== null) continue;
            Object.assign(row, data);
            count += 1;
          }
          return { count };
        },
      },
    },
  };
}

test("legacy AccessSnapshot read/write is allowed only before irreversible opaque enforcement", async () => {
  const open = policyDb(false);
  await assert.doesNotReject(assertLegacyAccessSnapshotReadable({ db: open.db, agencyId: "agency-1" }));
  await assert.doesNotReject(assertLegacyAccessSnapshotWritable({ db: open.db, agencyId: "agency-1" }));

  const enforced = policyDb(true);
  await assert.rejects(
    assertLegacyAccessSnapshotReadable({ db: enforced.db, agencyId: "agency-1" }),
    (error) => error?.code === "CRYPTO_LEGACY_ACCESS_SNAPSHOT_READ_DISABLED",
  );
  await assert.rejects(
    assertLegacyAccessSnapshotWritable({ db: enforced.db, agencyId: "agency-1" }),
    (error) => error?.code === "CRYPTO_LEGACY_ACCESS_SNAPSHOT_WRITE_DISABLED",
  );
});

test("legacy AccessSnapshot crypto-shred removes every server-decryptable field but keeps rows", async () => {
  const { db, snapshots } = policyDb(false);
  assert.equal(await countLegacyAccessSnapshotSecrets({ db, agencyId: "agency-1" }), 2);
  const retiredAt = new Date("2026-08-23T22:30:00Z");
  assert.equal(await cryptoShredLegacyAccessSnapshotSecrets({ db, agencyId: "agency-1", retiredAt }), 2);
  assert.equal(await countLegacyAccessSnapshotSecrets({ db, agencyId: "agency-1" }), 0);
  for (const row of snapshots) {
    assert.equal(row.encryptedPayload, null);
    assert.equal(row.iv, null);
    assert.equal(row.tag, null);
    assert.equal(row.algorithm, null);
    assert.equal(row.active, false);
    assert.equal(row.payloadRetiredAt, retiredAt);
  }
});

test("AccessSnapshot routes are creator-scoped and plaintext payload reads require a device-bound access token", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/access-snapshots.js"), "utf8");
  assert.match(source, /requireCreatorAccess/);
  assert.match(source, /requireAuthDevice/);
  assert.match(source, /ACCESS_SNAPSHOT_DEVICE_BOUND_TOKEN_REQUIRED/);
  assert.match(source, /assertLegacyAccessSnapshotReadable/);
  assert.match(source, /SNAPSHOT_SECRET_RETIRED/);
  const revokeStart = source.indexOf('router.post("/access-snapshots/:id/revoke"');
  const revokeBlock = source.slice(revokeStart);
  const policy = fs.readFileSync(path.join(__dirname, "legacy-access-snapshot-policy.js"), "utf8");
  assert.match(revokeBlock, /requireAuthDevice/);
  assert.match(revokeBlock, /cryptoShredLegacyAccessSnapshotById/);
  assert.match(policy, /payloadRetiredAt: retiredAt/);
  assert.match(policy, /encryptedPayload:\s*null/);
  assert.match(policy, /iv:\s*null/);
  assert.match(policy, /tag:\s*null/);
  assert.match(policy, /algorithm:\s*null/);
});

test("legacy creator-connect/import AccessSnapshot writers are physically retired", () => {
  assert.equal(fs.existsSync(path.join(__dirname, "../routes/creator-connect.js")), false);
  assert.equal(fs.existsSync(path.join(__dirname, "../routes/creator-import.js")), false);
  const server = fs.readFileSync(path.join(__dirname, "../server.js"), "utf8");
  assert.doesNotMatch(server, /creator-connect|creator-import|dev-migration\/import-local/);
});

test("Prisma contract can null AccessSnapshot secrets and deploy migration shreds already-enforced intermediate rows", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260823220000_client_e2e_retire_legacy_access_snapshot_secrets/migration.sql"), "utf8");
  assert.match(schema, /model AccessSnapshot[\s\S]*encryptedPayload\s+String\?[\s\S]*iv\s+String\?[\s\S]*tag\s+String\?[\s\S]*payloadRetiredAt\s+DateTime\?/);
  assert.match(migration, /ALTER COLUMN "encryptedPayload" DROP NOT NULL/);
  assert.match(migration, /FROM "AgencyCryptoRoot" AS root/);
  assert.match(migration, /root\."enforceOpaqueSecrets" = TRUE/);
  assert.match(migration, /"encryptedPayload" = NULL/);
});


test("legacy proxy migration cannot decrypt SERVER_V1 credentials after opaque enforcement", () => {
  const source = fs.readFileSync(path.join(__dirname, "creator-network-profile-service.js"), "utf8");
  const start = source.indexOf("async function migrateProxyCredentialsToOpaque");
  const end = source.indexOf("module.exports", start);
  const block = source.slice(start, end);
  const rootCheck = block.indexOf("assertLegacySecretAllowed(await cryptoRootPolicy(tx, agencyId))");
  const decrypt = block.indexOf("decryptServerProxyCredentials(proxy)");
  assert.ok(rootCheck >= 0, "migration must check opaque enforcement inside its Serializable transaction");
  assert.ok(decrypt > rootCheck, "legacy decrypt must happen only after the in-transaction enforcement check");
});

test("generic plaintext proxy creation participates in the same Serializable opaque-enforcement fence", () => {
  const source = fs.readFileSync(path.join(__dirname, "creator-network-profile-service.js"), "utf8");
  const start = source.indexOf("async function createProxyEndpoint");
  const end = source.indexOf("async function createProxyForCreator", start);
  const block = source.slice(start, end);
  assert.match(block, /runSerializable\(db/);
  assert.match(block, /cryptoRootPolicy\(tx, agencyId\)/);
  assert.match(block, /assertLegacySecretAllowed/);
});

test("global AccessSnapshot crypto-shred preserves an earlier revoke timestamp and records the actual payload retirement time", async () => {
  const { db, snapshots } = policyDb(false);
  const oldRevokedAt = new Date("2026-08-20T10:00:00Z");
  snapshots[1].revokedAt = oldRevokedAt;
  snapshots[1].active = false;
  const retiredAt = new Date("2026-08-24T14:40:00Z");

  await cryptoShredLegacyAccessSnapshotSecrets({ db, agencyId: "agency-1", retiredAt });

  assert.equal(snapshots[0].revokedAt, retiredAt, "a still-active snapshot is revoked when its secret is retired");
  assert.equal(snapshots[1].revokedAt, oldRevokedAt, "historical revoke provenance must not be rewritten by later crypto-shred");
  assert.equal(snapshots[1].payloadRetiredAt, retiredAt, "payloadRetiredAt records when ciphertext was actually destroyed");
});

test("manual AccessSnapshot revoke delegates timestamp-safe crypto retirement to the centralized helper", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/access-snapshots.js"), "utf8");
  const revokeStart = source.indexOf('router.post("/access-snapshots/:id/revoke"');
  const revokeBlock = source.slice(revokeStart);
  assert.match(revokeBlock, /prisma\.\$transaction/);
  assert.match(revokeBlock, /cryptoShredLegacyAccessSnapshotById/);
  assert.doesNotMatch(revokeBlock, /snapshot\.payloadRetiredAt \|\| snapshot\.revokedAt/);
});


test("single AccessSnapshot crypto-shred never rewrites timestamps won by a concurrent revoke/enforcement", async () => {
  const { db, snapshots } = policyDb(false);
  snapshots[0].id = "snapshot-1";
  snapshots[1].id = "snapshot-2";
  const priorRevokedAt = new Date("2026-08-24T13:00:00Z");
  const priorRetiredAt = new Date("2026-08-24T13:01:00Z");
  snapshots[0].revokedAt = priorRevokedAt;
  snapshots[0].payloadRetiredAt = priorRetiredAt;
  snapshots[0].active = false;
  snapshots[0].encryptedPayload = null;
  snapshots[0].iv = null;
  snapshots[0].tag = null;
  snapshots[0].algorithm = null;

  const laterRequestTime = new Date("2026-08-24T14:50:00Z");
  await cryptoShredLegacyAccessSnapshotById({ db, agencyId: "agency-1", snapshotId: "snapshot-1", retiredAt: laterRequestTime });

  assert.equal(snapshots[0].revokedAt, priorRevokedAt, "a stale manual revoke cannot overwrite the earlier revoke event");
  assert.equal(snapshots[0].payloadRetiredAt, priorRetiredAt, "a stale manual revoke cannot overwrite the earlier payload retirement event");
});

test("single AccessSnapshot crypto-shred stamps only missing provenance fields and retires live ciphertext", async () => {
  const { db, snapshots } = policyDb(false);
  snapshots[0].id = "snapshot-1";
  snapshots[1].id = "snapshot-2";
  const retiredAt = new Date("2026-08-24T14:55:00Z");
  await cryptoShredLegacyAccessSnapshotById({ db, agencyId: "agency-1", snapshotId: "snapshot-1", retiredAt });
  assert.equal(snapshots[0].revokedAt, retiredAt);
  assert.equal(snapshots[0].payloadRetiredAt, retiredAt);
  assert.equal(snapshots[0].encryptedPayload, null);
  assert.equal(snapshots[0].active, false);
});


test("legacy AccessSnapshot payload is re-read after authorization before any decrypt", () => {
  const source = fs.readFileSync(path.join(__dirname, "../routes/access-snapshots.js"), "utf8");
  const start = source.indexOf('router.get("/access-snapshots/:id/payload"');
  const end = source.indexOf('router.post("/access-snapshots/:id/revoke"', start);
  const block = source.slice(start, end);
  const firstRead = block.indexOf("prisma.accessSnapshot.findFirst");
  const authGate = block.indexOf("requireAuthDevice", firstRead);
  const finalRead = block.indexOf("const currentSnapshot = await prisma.accessSnapshot.findFirst", authGate);
  const decrypt = block.indexOf("decryptSnapshot(currentSnapshot)", finalRead);
  assert.ok(firstRead >= 0 && authGate > firstRead, "metadata lookup must happen before authorization");
  assert.ok(finalRead > authGate, "secret-bearing snapshot must be re-read only after access/device authorization");
  assert.ok(decrypt > finalRead, "decrypt must use the post-authorization snapshot, never the stale metadata lookup");
});
