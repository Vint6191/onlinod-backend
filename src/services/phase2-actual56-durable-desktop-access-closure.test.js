"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("desktop bootstrap and secret delta publish both durable authorization generations", () => {
  const bootstrap = read("src/services/desktop-bootstrap-service.js");
  const secretDelta = read("src/services/desktop-secret-delta-service.js");
  const authority = read("src/services/desktop-current-access-authority-service.js");
  assert.match(bootstrap, /creatorCatalogGeneration/);
  assert.match(bootstrap, /accessEpoch/);
  assert.match(secretDelta, /desktopAuthorityProof\(liveMember, creatorCatalogGeneration\)/);
  assert.match(authority, /accessEpoch/);
  assert.match(authority, /creatorCatalogGeneration/);
});

test("control events expose fresh durable proof and remain wakeup transport rather than authorization truth", () => {
  const route = read("src/routes/desktop.js");
  const events = read("src/services/desktop-control-events.js");
  assert.match(route, /withStableDesktopCurrentAccess/);
  assert.match(route, /authority:\s*filtered\.authority/);
  assert.match(route, /desktopAuthorityProof/);
  assert.match(events, /MAX_EVENTS\s*=\s*5000/);
  // The in-memory queue may remain best-effort, but broad access changes must
  // not depend on per-Creator revoke fanout for correctness.
  const team = read("src/services/team-administration-service.js");
  assert.doesNotMatch(team, /for\s*\([^)]*creator[^)]*\)[\s\S]{0,500}CREATOR_REVOKED/i);
});

test("crypto secret/key-state reads reuse current Member + User + Agency desktop authority", () => {
  const crypto = read("src/services/client-e2e-keyring-service.js");
  assert.match(crypto, /readCurrentDesktopMemberAuthority/);
  assert.match(crypto, /getCryptoStatus[\s\S]*readCurrentCryptoMember/);
  assert.match(crypto, /getCreatorKeyState[\s\S]*readCurrentCryptoMember/);
});

test("creator catalog generation is durable DB truth for membership changes", () => {
  const migration = read("prisma/migrations/20260912004000_phase2_actual56_creator_management_catalog_authority/migration.sql");
  assert.match(migration, /AFTER INSERT OR DELETE OR UPDATE OF "agencyId", "deletedAt"/);
  assert.match(migration, /"generation" = "AgencyCreatorCatalogState"\."generation" \+ 1/);
});
