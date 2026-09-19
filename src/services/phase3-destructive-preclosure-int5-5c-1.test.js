"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..");
function read(relative) { return fs.readFileSync(path.join(SRC, relative), "utf8"); }
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

test("INT5.5C-1 writer anti-map keeps all canonical FanData writes centralized", () => {
  const writePatterns = [
    /\bcreatorFanRelationshipCurrent\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
    /\bcreatorFanValueCurrent\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
    /\bcreatorFan\.(?:create|createMany|update|updateMany|upsert|delete|deleteMany)\b/,
    /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"CreatorFan(?:RelationshipCurrent|ValueCurrent)?"/i,
  ];
  const offenders = [];
  for (const file of walk(SRC)) {
    const body = fs.readFileSync(file, "utf8");
    if (!writePatterns.some((pattern) => pattern.test(body))) continue;
    const relative = path.relative(SRC, file).replaceAll(path.sep, "/");
    if (relative !== "services/fan-data-authority-service.js") offenders.push(relative);
  }
  assert.deepEqual(offenders, []);
});

test("INT5.5C-1 executable current consumers re-enter canonical FanData before commit", () => {
  const followBack = read("services/follow-back-service.js");
  const bumps = read("services/bump-service.js");
  const likes = read("services/likes-service.js");
  const subscriber = read("services/subscriber-directory-service.js");
  assert.match(followBack, /JOIN\s+"CreatorFanRelationshipCurrent"/);
  assert.match(followBack, /creatorFollowsFanAuthorityVersion/);
  assert.match(bumps, /readFanCurrentMap/);
  assert.match(bumps, /validateBumpCurrentRelationship/);
  assert.match(likes, /readFanCurrentMap/);
  assert.match(likes, /evaluateLikesCurrent/);
  assert.match(subscriber, /readFanCurrent\(prisma/);
  assert.match(subscriber, /current\?\.relationship\?\.creatorFollowsFan/);
});

test("INT5.5C-1 snapshot/cohort stores are not promoted back into canonical current ownership", () => {
  const bumps = read("services/bump-service.js");
  const likes = read("services/likes-service.js");
  const subscriber = read("services/subscriber-directory-service.js");
  assert.match(bumps, /Relationship-looking metadata is historical trigger evidence only/);
  assert.match(bumps, /Current relationship fields are overlaid exclusively from FanDataAuthority/);
  assert.match(likes, /subscriberScanItem\.findMany/);
  assert.match(likes, /readFanCurrentMap/);
  assert.match(subscriber, /Legacy flat aliases are response-time derivations of canonical current/);
});

test("INT5.5C-1 production migration command keeps online preflights ahead of Prisma deploy", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));
  const migrate = String(pkg.scripts?.["prisma:migrate"] || "");
  const provenance = migrate.indexOf("phase3-fandata-delivery-provenance-online-preflight.js");
  const campaignCoverage = migrate.indexOf("phase3-campaign-coverage-generation-online-preflight.js");
  const deploy = migrate.indexOf("prisma migrate deploy");
  assert.ok(provenance >= 0, "provenance online preflight must remain present");
  assert.ok(campaignCoverage > provenance, "campaign coverage preflight must run after provenance preflight");
  assert.ok(deploy > campaignCoverage, "all online preflights must complete before Prisma deploy");
});
