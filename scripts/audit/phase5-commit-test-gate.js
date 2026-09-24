"use strict";

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const selection = require("./phase5-commit-tests.json");
const root = path.resolve(__dirname, "../..");
for (const item of selection.historicalOnly) {
  console.log(`[historical-only, not counted as PASS] ${item.file}: ${item.reason}`);
}
const result = spawnSync(process.execPath, ["--test", ...selection.active], {
  cwd: root,
  stdio: "inherit",
  // These are unit/contract tests. An accidentally unstubbed query must not
  // contact a production database inherited from a developer's shell.
  env: { ...process.env, DATABASE_URL: "postgresql://phase5:phase5@127.0.0.1:1/phase5_disposable" },
});
if (result.error) console.error(result.error.message);
process.exitCode = result.status === 0 ? 0 : 1;
