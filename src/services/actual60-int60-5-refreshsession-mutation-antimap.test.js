"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const srcRoot = path.join(root, "src");

function productionJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) productionJsFiles(full, out);
    else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function updateManyBlocks(source) {
  const needle = "refreshSession.updateMany(";
  const blocks = [];
  let cursor = 0;
  while (true) {
    const start = source.indexOf(needle, cursor);
    if (start < 0) break;
    const next = source.indexOf("refreshSession.updateMany(", start + needle.length);
    blocks.push(source.slice(start, next < 0 ? Math.min(source.length, start + 1800) : Math.min(next, start + 1800)));
    cursor = start + needle.length;
  }
  return blocks;
}

test("INT60.5 RefreshSession mutation anti-map: every broad production updateMany is live-bounded", () => {
  const findings = [];
  let count = 0;
  for (const file of productionJsFiles(srcRoot)) {
    const source = fs.readFileSync(file, "utf8");
    const blocks = updateManyBlocks(source);
    for (const block of blocks) {
      count += 1;
      const whereEnd = block.indexOf("data:");
      const where = whereEnd >= 0 ? block.slice(0, whereEnd) : block;
      const exactId = /\bid\s*:\s*(?!\{\s*not\b)/.test(where);
      const lifetimeBounded = /expiresAt\s*:\s*\{\s*gt\s*:/.test(where);
      if (!exactId && !lifetimeBounded) {
        findings.push({ file: rel(file), where: where.replace(/\s+/g, " ").slice(0, 500) });
      }
    }
  }
  assert.equal(count, 18, `RefreshSession updateMany touchpoint count changed; re-audit mutation classification before updating this freeze gate (count=${count})`);
  assert.deepEqual(findings, [], `broad RefreshSession mutations must exclude expired history: ${JSON.stringify(findings)}`);
});

test("INT60.5 RefreshSession mutation anti-map: raw production SQL does not bypass the classified Prisma writers", () => {
  const offenders = [];
  for (const file of productionJsFiles(srcRoot)) {
    const source = fs.readFileSync(file, "utf8");
    if (/UPDATE\s+"RefreshSession"|DELETE\s+FROM\s+"RefreshSession"/i.test(source)) offenders.push(rel(file));
  }
  assert.deepEqual(offenders, []);
});
