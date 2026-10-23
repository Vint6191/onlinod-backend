"use strict";
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { createRequire } = require("node:module"), { pathToFileURL } = require("node:url");

// Compile the exact paired Desktop source. Provider fixtures enter the actual
// handlers; the proof does not reproduce their traversal or normalizer logic.
async function loadDesktopCollectorHandlers(desktopRoot) {
  const desktop = path.resolve(desktopRoot, "apps/desktop"), sourceRoot = path.join(desktop, "electron/main");
  const ts = createRequire(path.join(desktop, "package.json"))("typescript");
  const compiled = fs.mkdtempSync(path.join(os.tmpdir(), "collector-handlers-")), visited = new Set();
  fs.writeFileSync(path.join(compiled, "package.json"), '{"type":"module"}');
  function compile(file) {
    if (visited.has(file)) return; visited.add(file);
    const result = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }, fileName: file,
    });
    const target = path.join(compiled, path.relative(sourceRoot, file).replace(/\.ts$/, ".js"));
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, result.outputText);
    for (const match of result.outputText.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g))
      compile(path.resolve(path.dirname(file), match[1].replace(/\.js$/, ".ts")));
  }
  try {
    const handlers = {};
    for (const [file, name] of [["notifications-catchup-handler", "notificationsCatchupHandler"], ["dialog-intelligence-handler", "dialogIntelligenceHandler"]]) {
      compile(path.join(sourceRoot, `services/backend-jobs/handlers/${file}.ts`));
      handlers[name] = (await import(pathToFileURL(path.join(compiled, `services/backend-jobs/handlers/${file}.js`))))[name];
    }
    return { ...handlers, close: () => fs.rmSync(compiled, { recursive: true, force: true }) };
  } catch (error) { fs.rmSync(compiled, { recursive: true, force: true }); throw error; }
}
module.exports = { loadDesktopCollectorHandlers };
