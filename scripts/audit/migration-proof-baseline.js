"use strict";
const fs = require("node:fs"), path = require("node:path");
function copyHistoricalMigrationPrefix(source, destination, target) {
  if (!fs.statSync(path.join(source, target)).isDirectory()) throw Error("Unknown target migration: " + target);
  fs.mkdirSync(destination, { recursive: true });
  for (const name of fs.readdirSync(source).sort()) {
    const file = path.join(source, name);
    if (fs.statSync(file).isDirectory() && name >= target) continue;
    fs.cpSync(file, path.join(destination, name), { recursive: true });
  }
}
module.exports = { copyHistoricalMigrationPrefix };
