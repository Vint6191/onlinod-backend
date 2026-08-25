"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");

test("V20.22 creator-session runtime is CLIENT_E2E-only", () => {
  const route = read("src/routes/creator-sessions.js");
  const service = read("src/services/creator-session-broker-service.js");

  assert.doesNotMatch(route, /migrate-opaque|\bpayloadSchema\b|legacyWrite/i);
  assert.match(route, /opaquePayload/);
  assert.doesNotMatch(service, /snapshot-crypto|decryptSnapshot|encryptSnapshot|migrateCreatorSessionToOpaque/);
  assert.match(service, /CREATOR_SESSION_E2E_REQUIRED/);
  assert.match(service, /CREATOR_SESSION_LEGACY_ENVELOPE_UNSUPPORTED/);
});

test("V20.22 proxy credential runtime is CLIENT_E2E-only", () => {
  const route = read("src/routes/network-profiles.js");
  const service = read("src/services/creator-network-profile-service.js");
  const credentials = read("src/services/proxy-credentials.js");

  assert.doesNotMatch(route, /migration-material|migrate-credentials/);
  assert.match(route, /opaqueCredentials/);
  assert.doesNotMatch(service, /decryptServer|serverEncrypted|migrateProxyCredentialsToOpaque|cryptoRootPolicy/);
  assert.match(service, /PROXY_PLAINTEXT_CREDENTIALS_UNSUPPORTED/);
  assert.doesNotMatch(credentials, /snapshot-crypto|decryptSnapshot|encryptSnapshot/);
  assert.match(credentials, /CLIENT_E2E_V1/);
});

test("V20.22 schema defaults and deploy guard enforce CLIENT_E2E-only", () => {
  const schema = read("prisma/schema.prisma");
  const migration = read("prisma/migrations/20260824213000_client_e2e_only_runtime_v20_22/migration.sql");
  const keyringRoute = read("src/routes/client-e2e-keyring.js");

  const defaults = schema.match(/encryptionMode\s+SecretEncryptionMode\s+@default\(CLIENT_E2E_V1\)/g) || [];
  assert.equal(defaults.length, 2);
  const enumStart = schema.indexOf("enum SecretEncryptionMode {");
  const enumEnd = schema.indexOf("\n}", enumStart);
  const enumBlock = schema.slice(enumStart, enumEnd + 2);
  assert.doesNotMatch(enumBlock, /SERVER_V1/);
  assert.match(enumBlock, /CLIENT_E2E_V1/);
  assert.match(migration, /ACTIVE SERVER_V1 creator sessions remain/);
  assert.match(migration, /SERVER_V1 proxy credentials remain/);
  assert.match(migration, /RAISE EXCEPTION/);
  assert.doesNotMatch(keyringRoute, /\/enforce-opaque/);
});
