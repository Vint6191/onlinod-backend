'use strict';
// Contract-only source evidence. Ordinary patches never rewrite phase7-release.json.
const fs = require('node:fs/promises');
const path = require('node:path');
const { failure, GENERATION, manifest, sha } = require('../../src/services/phase7-legacy-storage-service');
const { sourcePaths } = require('./phase7-source-inventory');
const HASH = /^[a-f0-9]{64}$/;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const IDENTITY_KEYS = ['generation', 'planHash', 'packageId', 'baseBackendHash', 'baseDesktopHash', 'backendHash', 'desktopHash'];
const inside = (root, file) => file === root || file.startsWith(root + path.sep);

function identity(value) {
  if (!value || value.generation !== GENERATION || value.planHash !== manifest.planHash
      || typeof value.packageId !== 'string' || !/^[A-Za-z0-9._-]{1,200}$/.test(value.packageId)
      || !['baseBackendHash', 'baseDesktopHash', 'backendHash', 'desktopHash'].every(k => typeof value[k] === 'string' && HASH.test(value[k]))) {
    throw failure('PHASE7_RELEASE_MANIFEST_INVALID');
  }
  return Object.fromEntries(IDENTITY_KEYS.map(k => [k, value[k]]));
}
function sameRelease(expected, actual) {
  const a = identity(expected), b = identity(actual);
  if (IDENTITY_KEYS.some(k => a[k] !== b[k])) throw failure('PHASE7_PREPARED_RELEASE_MISMATCH');
  return a;
}
function validEntry(entry) {
  if (!entry || typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\')
      || entry.path.includes('\0') || path.posix.isAbsolute(entry.path) || path.win32.isAbsolute(entry.path)
      || entry.path.split('/').some(x => !x || x === '.' || x === '..')) throw failure('PHASE7_RELEASE_PATH_INVALID');
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_FILE_BYTES
      || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)) throw failure('PHASE7_RELEASE_ENTRY_INVALID');
}
function validateInventory(entries, digest) {
  if (!Array.isArray(entries) || !entries.length || entries.length > 5000) throw failure('PHASE7_RELEASE_MANIFEST_INVALID');
  let previous = null;
  for (const entry of entries) {
    validEntry(entry);
    if (previous !== null && previous >= entry.path) throw failure('PHASE7_RELEASE_SOURCE_SET_MISMATCH');
    previous = entry.path;
  }
  if (sha(JSON.stringify(entries)) !== digest) throw failure('PHASE7_RELEASE_HASH_INVALID');
}
async function realRoot(root) {
  const full = path.resolve(root), st = await fs.lstat(full);
  if (!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(full) !== full) throw failure('PHASE7_RELEASE_SYMLINK');
  return full;
}
async function fileEntry(root, name) {
  const full = path.join(root, name), st = await fs.lstat(full);
  if (!st.isFile() || st.isSymbolicLink() || await fs.realpath(full) !== full) throw failure('PHASE7_RELEASE_SYMLINK');
  if (st.size > MAX_FILE_BYTES) throw failure('PHASE7_RELEASE_ENTRY_INVALID', { file: name });
  const bytes = await fs.readFile(full);
  if (bytes.length !== st.size) throw failure('PHASE7_RELEASE_SOURCE_MISMATCH', { file: name });
  return { path: name, bytes: bytes.length, sha256: sha(bytes) };
}
async function inventory(root) {
  root = await realRoot(root);
  const names = await sourcePaths(root), entries = [];
  for (const name of names) entries.push(await fileEntry(root, name));
  if (entries.length > 5000) throw failure('PHASE7_SOURCE_INVENTORY_LIMIT');
  if (JSON.stringify(names) !== JSON.stringify(await sourcePaths(root))) throw failure('PHASE7_RELEASE_SOURCE_SET_MISMATCH');
  return entries;
}
async function verifyInventory(root, entries) {
  const actual = await inventory(root);
  if (JSON.stringify(actual.map(e => e.path)) !== JSON.stringify(entries.map(e => e.path))) throw failure('PHASE7_RELEASE_SOURCE_SET_MISMATCH');
  for (let i = 0; i < entries.length; i++) {
    if (actual[i].bytes !== entries[i].bytes || actual[i].sha256 !== entries[i].sha256) {
      throw failure('PHASE7_RELEASE_SOURCE_MISMATCH', { file: entries[i].path });
    }
  }
}
async function readManifest(root, { file } = {}) {
  root = await realRoot(root);
  const name = path.resolve(file || path.join(root, 'phase7-release.json'));
  // A fresh external receipt must not become a self-referential source file.
  if (name !== path.join(root, 'phase7-release.json') && inside(root, name)) throw failure('PHASE7_RELEASE_FILE_MUST_BE_EXTERNAL');
  const st = await fs.lstat(name);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 2 * 1024 * 1024 || await fs.realpath(name) !== name) throw failure('PHASE7_RELEASE_MANIFEST_INVALID');
  const bytes = await fs.readFile(name);
  if (bytes.length !== st.size || bytes.length > 2 * 1024 * 1024) throw failure('PHASE7_RELEASE_MANIFEST_INVALID');
  let document;
  try { document = JSON.parse(bytes.toString('utf8')); } catch { throw failure('PHASE7_RELEASE_MANIFEST_INVALID'); }
  if (document?.version !== 1) throw failure('PHASE7_RELEASE_MANIFEST_INVALID');
  const release = identity(document);
  validateInventory(document.backendFiles, release.backendHash);
  validateInventory(document.desktopFiles, release.desktopHash);
  await verifyInventory(root, document.backendFiles);
  return { document, release };
}
async function readRelease(root, options) { return (await readManifest(root, options)).release; }
async function createRelease({ backendRoot, desktopRoot, baseBackendRoot, baseDesktopRoot, packageId }) {
  const roots = await Promise.all([backendRoot, desktopRoot, baseBackendRoot, baseDesktopRoot].map(realRoot));
  const [backendFiles, desktopFiles, baseBackendFiles, baseDesktopFiles] = await Promise.all(roots.map(inventory));
  for (const entries of [backendFiles, desktopFiles, baseBackendFiles, baseDesktopFiles]) validateInventory(entries, sha(JSON.stringify(entries)));
  const document = { version: 1, generation: GENERATION, planHash: manifest.planHash, packageId,
    baseBackendHash: sha(JSON.stringify(baseBackendFiles)), baseDesktopHash: sha(JSON.stringify(baseDesktopFiles)),
    backendHash: sha(JSON.stringify(backendFiles)), desktopHash: sha(JSON.stringify(desktopFiles)), backendFiles, desktopFiles };
  identity(document);
  // All four trees must still match after the paired inventory was assembled.
  await Promise.all(roots.map((root, i) => verifyInventory(root, [backendFiles, desktopFiles, baseBackendFiles, baseDesktopFiles][i])));
  return document;
}
async function verifyStagedRelease(root, stagedRoot, names, { file, expectedRelease } = {}) {
  const { document, release } = await readManifest(root, { file });
  sameRelease(expectedRelease, release);
  const prefixes = names.map(name => `prisma/migrations/${name}/`);
  const entries = document.backendFiles.filter(e => e.path === 'prisma/schema.prisma'
    || e.path === 'prisma/migrations/migration_lock.toml' || prefixes.some(prefix => e.path.startsWith(prefix)))
    .map(e => ({ ...e, path: e.path.slice('prisma/'.length) }));
  await verifyInventory(stagedRoot, entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return release;
}
async function writeRelease(options) {
  const roots = await Promise.all(['backendRoot', 'desktopRoot', 'baseBackendRoot', 'baseDesktopRoot'].map(k => realRoot(options[k])));
  const output = path.resolve(options.output);
  if (roots.some(root => inside(root, output))) throw failure('PHASE7_RELEASE_FILE_MUST_BE_EXTERNAL');
  if (await fs.realpath(path.dirname(output)) !== path.dirname(output)) throw failure('PHASE7_RELEASE_SYMLINK');
  const document = await createRelease(options), data = JSON.stringify(document, null, 2) + '\n';
  if (Buffer.byteLength(data) > 2 * 1024 * 1024) throw failure('PHASE7_RELEASE_MANIFEST_INVALID');
  const handle = await fs.open(output, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
  return { file: output, ...identity(document) };
}
function argumentsForCreate(argv) {
  const keys = { 'backend-root': 'backendRoot', 'desktop-root': 'desktopRoot', 'base-backend-root': 'baseBackendRoot',
    'base-desktop-root': 'baseDesktopRoot', 'package-id': 'packageId', output: 'output' };
  const options = {};
  for (const arg of argv) {
    const match = /^--([^=]+)=(.+)$/.exec(arg), key = match && keys[match[1]];
    if (!key || Object.hasOwn(options, key)) throw failure('PHASE7_RELEASE_ARGUMENT_INVALID');
    options[key] = match[2];
  }
  if (Object.keys(options).length !== Object.keys(keys).length) throw failure('PHASE7_RELEASE_ARGUMENT_REQUIRED');
  return options;
}
module.exports = { identity, sameRelease, inventory, verifyInventory, readRelease, createRelease, verifyStagedRelease, writeRelease, argumentsForCreate };
if (require.main === module) {
  Promise.resolve().then(() => writeRelease(argumentsForCreate(process.argv.slice(2))))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
}
