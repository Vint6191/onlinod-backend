'use strict';

const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createRequire } = require('node:module');

// Real Desktop authorization, immutable command journal and executeOperation;
// the local API adapter enters the same backend preview and management owners.
// HTTP/session middleware is covered by the separate current-product workflow.
async function openNotificationManagementFixture(h, scope) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-management212-'));
  const desktopLoad = createRequire(path.join(h.desktopRoot, 'package.json'));
  const services = path.join(h.desktopRoot, 'apps/desktop/electron/main/services');
  const bundle = path.join(directory, 'management.cjs');
  await desktopLoad('esbuild').build({ stdin: { contents: [
    'export * from ' + JSON.stringify(path.join(services, 'management-commands/management-command-transport.ts')) + ';',
    'export * from ' + JSON.stringify(path.join(services, 'desktop-authorization/index.ts')) + ';',
  ].join('\n'), resolveDir: h.desktopRoot, sourcefile: 'management.ts', loader: 'ts' },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
  const modules = require(bundle), requests = [];
  const session = { apiBase: 'http://notification-management.fixture', user: { id: scope.userId },
    activeAgencyId: scope.agencyId, activeMemberId: scope.member.id, deviceId: scope.deviceId };
  const auth = { readSession: () => session, getDeviceId: () => scope.deviceId,
    getAuthorizationScopeIncarnation: () => scope.creatorId };
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, () => {}]));
  const authority = new modules.DesktopCurrentAuthorizationAuthorityService({ log, authStore: auth,
    accessRuntime: { currentAuthorityProof: () => ({ accessEpoch: scope.member.accessEpoch, creatorCatalogGeneration: 1 }),
      allowedCreatorIdsSnapshot: () => [scope.creatorId] } });
  authority.publish({ accessEpoch: scope.member.accessEpoch, creatorCatalogGeneration: 1, role: 'OWNER', roleKey: 'owner',
    effectivePermissions: { 'creator_analytics.refresh': true }, allowedCreatorIds: [scope.creatorId],
    observedAt: Date.now(), observedAtMono: performance.now(), billing: { version: 1, validForMs: 90000,
      creators: [{ creatorId: scope.creatorId, allowed: true, validForMs: 90000, reason: 'TRIAL' }] } }, 'native command fixture');
  const api = { async request(url, options) {
    requests.push({ url, input: structuredClone(options.body) });
    if (url === '/api/management/commands/v1/operation-preview') {
      const { creatorId, ...intent } = options.body;
      const operation = h.load('./src/services/operational-command-contract').operation.parse({ ...intent, expectedRevision: '0'.repeat(64) });
      return h.load('./src/services/db-commit-kernel').runRootCommit(h.db, async ({ tx }) => {
        const admitted = await h.load('./src/services/management-commit-authority-service').assertManagementCommitAuthority({
          tx, agencyId: scope.agencyId, actorMember: scope.member, creatorIds: [creatorId] });
        const owner = h.load('./src/services/operational-command-service');
        await owner.authorizeExtra(tx, admitted.member, operation);
        return { ok: true, expectedRevision: await owner.snapshot(tx, scope.agencyId, creatorId, operation) };
      }, { profile: 'SECRET_READ', maxAttempts: 1 });
    }
    if (url !== '/api/management/commands/v1') throw new Error('UNEXPECTED_MANAGEMENT_ENDPOINT');
    return h.load('./src/services/management-command-service').executeManagementCommand({ db: h.db,
      agencyId: scope.agencyId, userId: scope.userId, actorMember: scope.member, deviceId: scope.deviceId, input: options.body });
  } };
  const makeCommands = () => new modules.ManagementCommandTransport(api, auth, path.join(directory, 'commands.json'), authority, () => {});
  let commands = makeCommands();
  return { get commands() { return commands; }, requests, restart() { commands = makeCommands(); }, async forceFull() {
    const result = await commands.executeOperation('notification', scope.creatorId, 'start', { forceFull: true });
    return { commandId: result.commandId, job: await h.db.jobInstance.findUnique({ where: { id: result.job.id } }) };
  }, close() { authority.destroy(); fs.rmSync(directory, { recursive: true, force: true }); } };
}

module.exports = { openNotificationManagementFixture };
