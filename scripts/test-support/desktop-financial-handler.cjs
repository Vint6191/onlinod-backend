"use strict";
// Optional cross-repository proof uses the exact Desktop sources under test.
// No provider requests are made; callers supply explicit provider fixtures.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createRequire } = require("node:module"), { pathToFileURL } = require("node:url");
async function loadDesktopFinancialHandler(desktopRoot) {
  const desktop = path.resolve(desktopRoot, "apps/desktop"), sourceRoot = path.join(desktop, "electron/main");
  const ts = createRequire(path.join(desktop, "package.json"))("typescript"), compiled = fs.mkdtempSync(path.join(os.tmpdir(), "financial-bridge-"));
  fs.writeFileSync(path.join(compiled, "package.json"), '{"type":"module"}');
  const visited = new Set();
  function compile(file) {
    if (visited.has(file)) return; visited.add(file);
    const result = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, fileName: file });
    const target = path.join(compiled, path.relative(sourceRoot, file).replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, result.outputText);
    for (const match of result.outputText.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g)) compile(path.resolve(path.dirname(file), match[1].replace(/\.js$/, ".ts")));
  }
  try {
    compile(path.join(sourceRoot, "services/backend-jobs/handlers/financial-transactions-handler.ts"));
    const { financialTransactionsHandler } = await import(pathToFileURL(path.join(compiled, "services/backend-jobs/handlers/financial-transactions-handler.js")));
    return { handler: financialTransactionsHandler, close: () => fs.rmSync(compiled, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(compiled, { recursive: true, force: true }); throw error; }
}
module.exports = { loadDesktopFinancialHandler };
