"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "../..");
const schema = path.join(root, "prisma", "schema.prisma");
const outDir = path.join(root, "artifacts", "schema-comparison-only");
const outFile = path.join(outDir, "migration.sql");

if (!fs.existsSync(schema)) {
  console.error(`Prisma schema not found: ${schema}`);
  process.exit(1);
}

const prismaBin = process.platform === "win32"
  ? path.join(root, "node_modules", ".bin", "prisma.cmd")
  : path.join(root, "node_modules", ".bin", "prisma");

if (!fs.existsSync(prismaBin)) {
  console.error("Prisma CLI is not installed. Run npm install first; no database or output file was changed.");
  process.exit(2);
}

const run = spawnSync(prismaBin, [
  "migrate", "diff",
  "--from-empty",
  "--to-schema-datamodel", schema,
  "--script",
], {
  cwd: root,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

if (run.status !== 0) {
  process.stderr.write(run.stderr || "Prisma migrate diff failed.\n");
  process.exit(run.status || 1);
}

const sql = String(run.stdout || "").trim();
if (!sql) {
  console.error("Prisma returned an empty baseline; refusing to write an artifact.");
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, `-- SCHEMA COMPARISON ONLY. NOT A BOOTSTRAP. SQL-only guards, views, controls and history are absent.\n${sql}\n`, "utf8");
console.log(`Wrote unsupported-for-bootstrap Prisma schema comparison: ${path.relative(root, outFile)}`);
console.log("Do not apply this as a database bootstrap. Use npm run prisma:migrate with the canonical migration history.");
