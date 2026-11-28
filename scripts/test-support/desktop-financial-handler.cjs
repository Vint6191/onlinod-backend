"use strict";
// Optional cross-repository proof uses the exact Desktop sources under test.
// No provider requests are made; callers supply explicit provider fixtures.
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createRequire } = require("node:module"), { pathToFileURL } = require("node:url");
async function loadDesktopFinancialHandler(desktopRoot) {
  const desktop = path.resolve(desktopRoot, "apps/desktop"), sourceRoot = path.join(desktop, "electron/main");
  const load = createRequire(path.join(desktop, "package.json")), compiled = fs.mkdtempSync(path.join(os.tmpdir(), "financial-bridge-"));
  fs.writeFileSync(path.join(compiled, "package.json"), '{"type":"module"}');
  try {
    const bundle = path.join(compiled, "financial-transactions-handler.js");
    await load("esbuild").build({ entryPoints: [path.join(sourceRoot, "services/backend-jobs/handlers/financial-transactions-handler.ts")],
      outfile: bundle, bundle: true, platform: "node", format: "esm", logLevel: "silent",
      alias: { "@nod/shared": path.join(desktopRoot, "packages/shared/src/index.ts") } });
    const { financialTransactionsHandler } = await import(pathToFileURL(bundle));
    return { handler: financialTransactionsHandler, close: () => fs.rmSync(compiled, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(compiled, { recursive: true, force: true }); throw error; }
}
module.exports = { loadDesktopFinancialHandler };
