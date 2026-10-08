'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const excluded = new Set(['node_modules', 'dist', '.git']);
function discover(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) return [];
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return discover(full);
    return entry.isFile() && /\.(test|spec)\.(js|mjs|cjs)$/.test(entry.name) ? [path.relative(root, full)] : [];
  });
}
const files = discover(root).sort();
if (process.argv.includes('--list')) {
  console.log(JSON.stringify(files, null, 2));
  process.exit(0);
}
if (Number(process.versions.node.split('.')[0]) !== 22) {
  console.error('Full corpus is verified on Node 22.23.3. Use Node 22 with matching native dependencies.');
  process.exit(2);
}
if (fs.existsSync(path.join(root, 'apps/desktop'))) {
  const evidence = process.env.ONLINOD_CAMPAIGN_EVIDENCE;
  const fixtures = ['backend-fan-response.json', 'backend-page-response.json', 'backend-overview-response.json', 'backend-scan-response.json'];
  if (!evidence || fixtures.some(file => !fs.existsSync(path.join(evidence, file)))) {
    console.error('Missing real campaign SQL fixtures. Run the Backend campaign-read proof and set ONLINOD_CAMPAIGN_EVIDENCE; see TESTING141.md.');
    process.exit(2);
  }
}
console.log(`Full corpus: ${files.length} JS test/spec files; native acceptance remains a separate gate.`);
const result = spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-concurrency=4', ...files], {
  cwd: root, stdio: 'inherit', env: { ...process.env, CI: '1' }, timeout: 600_000,
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
