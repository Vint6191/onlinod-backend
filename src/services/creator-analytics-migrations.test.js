"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..");
const migrationPaths = [
  "prisma/migrations/20261009000000_current_baseline/migration.sql",
  "prisma/migrations/20261009000000_current_baseline/migration.sql",
  "prisma/migrations/20261009000000_current_baseline/migration.sql",
  "prisma/migrations/20261009000000_current_baseline/migration.sql",
  "prisma/migrations/20261009000000_current_baseline/migration.sql",
  "prisma/migrations/20261009000000_current_baseline/migration.sql",
];
const migrations = migrationPaths.map((relative) => ({ relative, text: fs.readFileSync(path.join(root, relative), "utf8") }));
const schema = fs.readFileSync(path.join(root, "prisma/schema.prisma"), "utf8");












test("analytics migrations contain no message bodies or JSON business payloads", () => {
  const allSql = migrations.map((item) => item.text).join("\n");
  assert.doesNotMatch(allSql, /messageText|bodyText|contentJson|payloadJson|rawJson/i);
  assert.match(allSql, /"CreatorMessagesDaily"/);
  assert.match(allSql, /"incomingMessages" INTEGER NOT NULL/);
  assert.match(allSql, /"outgoingMessages" INTEGER NOT NULL/);
});
