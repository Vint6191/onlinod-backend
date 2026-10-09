"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const root = path.resolve(__dirname, "..");
const contract = require("./database-contract.json");
const business = require("../../scripts/test-support/current-business-contract.json");
function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.(?:js|cjs|mjs)$/.test(entry.name) && !/\.(?:test|spec)\./.test(entry.name) ? [file] : [];
  });
}
test("runtime literal SQL relations belong to the installed schema", () => {
  const relations = new Set([...contract.tables, ...contract.views].map(row => row.name));
  relations.add("_prisma_migrations");
  const unresolved = [];
  for (const file of sources(root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+"([A-Z]\w+)"/g)) {
      if (!relations.has(match[1])) unresolved.push(`${path.relative(root, file)}: ${match[1]}`);
    }
  }
  assert.deepEqual(unresolved, []);
});
test("runtime does not address retired Prisma models or retired dynamic table names", () => {
  const schema = fs.readFileSync(path.join(root, "../prisma/schema.prisma"), "utf8");
  const models = new Set([...schema.matchAll(/^model (\w+)\s*\{/gm)].map(match => match[1]));
  // Team's retained logical model names map to new physical Current tables.
  const retired = business.retiredTables.filter(name => !models.has(name));
  const unresolved = [];
  for (const file of sources(root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const name of retired) {
      const delegate = name[0].toLowerCase() + name.slice(1);
      if (new RegExp(`(?:["'\x60]${name}["'\x60]|\\.${delegate}\\s*(?:\\.|\\?\\.))`).test(text)) {
        unresolved.push(`${path.relative(root, file)}: ${name}`);
      }
    }
  }
  assert.deepEqual(unresolved, []);
});
