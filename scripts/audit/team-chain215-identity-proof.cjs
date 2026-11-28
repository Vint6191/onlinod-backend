"use strict";
// Installed native PostgreSQL, actual canonical event persistence and triggers.
// Only agency/member/creator identities and provider observations are fixtures.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');

async function runTeamIdentityProof({ db, backendRoot = path.resolve(__dirname, '../..') }) {
  const load = createRequire(path.join(backendRoot, 'package.json'));
  const { runRootCommit } = load('./src/services/db-commit-kernel');
  const { persistCanonicalTeamEventRow } = load('./src/services/telemetry-ingest-service');
  const agencyId = 'team215-identity';
  const creatorA = 'team215-identity-a', creatorB = 'team215-identity-b';
  const firstMember = 'team215-first', secondMember = 'team215-second';
  const now = new Date((await db.$queryRawUnsafe('SELECT clock_timestamp() AS now'))[0].now);
  await runRootCommit(db, async ({ tx }) => {
    await tx.$queryRawUnsafe(`SELECT set_config('onlinod.phase2_team_control_plane_generation','phase2_team_control_plane_v2_durable_access',true),set_config('onlinod.phase2_creator_writer_generation','phase2_creator_writer_v2_actual56_postcut',true)`);
    await tx.agency.create({ data: { id: agencyId, name: 'Team identity proof 215' } });
    for (const id of [firstMember, secondMember]) {
      await tx.user.create({ data: { id: id + '-user', email: id + '@example.test', passwordHash: 'fixture' } });
      await tx.agencyMember.create({ data: { id, agencyId, userId: id + '-user', role: id === firstMember ? 'OWNER' : 'OPERATOR', roleKey: id === firstMember ? 'owner' : 'chatter', assignedCreators: 'all' } });
    }
    for (const id of [creatorA, creatorB]) await tx.creatorAccount.create({ data: { id, agencyId, displayName: id, remoteId: id, status: 'READY' } });
    for (const id of ['team215-device-a', 'team215-device-b']) await tx.workerDevice.create({ data: { id, agencyId, userId: firstMember + '-user' } });
  });
  const checks = [];
  const check = (name, actual, expected) => {
    try { assert.deepEqual(actual, expected); checks.push({ name, ok: true }); }
    catch { checks.push({ name, ok: false, actual, expected }); }
  };
  const base = {
    agencyId, deviceId: 'team215-device-a', userId: firstMember + '-user', memberId: firstMember,
    accountId: creatorA, creatorId: creatorA, fanId: 'fan-one', dialogId: 'fan-one',
    type: 'message_send_confirmed', eventKind: 'MESSAGE_SEND_CONFIRMED', actionSource: 'MANUAL', lifecycle: 'CONFIRMED',
    messageId: 'provider-message-one', semanticEventKey: creatorA + ':message:provider-message-one',
    localId: 'legacy-local-one', priceCents: 1200, currency: 'USD', isPpv: true, mediaCount: 1,
    ts: now, source: 'electron_team_v13', extra: { sourceDetail: 'of_response_observed' },
  };
  const persist = row => runRootCommit(db, ({ tx }) => persistCanonicalTeamEventRow({ db: tx, row }), { profile: 'TEAM_MANAGEMENT' });
  await persist(base);
  const duplicate = await persist({ ...base, priceCents: 9999, mediaCount: 8 });
  check('same identity replay is acknowledged from immutable stored payload', {
    duplicated: duplicate.duplicated, cents: duplicate.row.priceCents, media: duplicate.row.mediaCount,
  }, { duplicated: true, cents: 1200, media: 1 });
  const crossCreator = await persist({ ...base, accountId: creatorB, creatorId: creatorB, semanticEventKey: creatorB + ':message:provider-message-one' });
  check('old localId collision with another creator is rejected explicitly', crossCreator.rejected || null, 'local_id_identity_conflict');
  const crossDialog = await persist({ ...base, fanId: 'fan-two', dialogId: 'fan-two' });
  check('old localId collision with another dialog is rejected explicitly', crossDialog.rejected || null, 'local_id_identity_conflict');
  const crossMessage = await persist({ ...base, messageId: 'provider-message-two', semanticEventKey: creatorA + ':message:provider-message-two' });
  check('old localId collision with another provider message is rejected explicitly', crossMessage.rejected || null, 'local_id_identity_conflict');
  await persist({ ...base, localId: 'scoped-v2-local-one', memberId: secondMember, userId: secondMember + '-user' });
  await persist({ ...base, localId: 'another-device-local-one', deviceId: 'team215-device-b', memberId: secondMember, userId: secondMember + '-user' });
  const sent = await db.teamSentMessageLedger.findMany({ where: { agencyId } });
  check('legacy/scoped/two-device replay retains one sender and original gross offer', sent.map(row => ({ memberId: row.memberId, messageId: row.messageId, priceCents: row.priceCents })),
    [{ memberId: firstMember, messageId: base.messageId, priceCents: 1200 }]);
  const contributions = await db.teamActivityContribution.findMany({ where: { agencyId }, select: { memberId: true, messagesSent: true, ppvSentMessages: true } });
  check('legacy/scoped/two-device replay has one canonical first-actor contribution', contributions,
    [{ memberId: firstMember, messagesSent: 1, ppvSentMessages: 1 }]);
  const daily = await db.teamMemberActivityDaily.findMany({ where: { agencyId }, select: { memberId: true, messagesSent: true } });
  check('daily projection counts one provider message after replay', daily, [{ memberId: firstMember, messagesSent: 1 }]);
  await persist({ ...base, localId: 'scoped-v2-other-creator', accountId: creatorB, creatorId: creatorB, semanticEventKey: creatorB + ':message:provider-message-one' });
  check('same provider ID for another creator survives its scoped key', await db.teamSentMessageLedger.count({ where: { agencyId } }), 2);
  check('Team observation does not manufacture canonical paid revenue', await db.teamMoneyAttributionFact.count({ where: { agencyId } }), 0);
  return { ok: checks.every(row => row.ok), engine: 'native PostgreSQL + actual event persistence, ledger and projection trigger', checks };
}
module.exports = { runTeamIdentityProof };
if (require.main === module) (async () => {
  const runtime = await require(process.env.NOD_TEAM_NATIVE_FIXTURE).createNativeRuntime();
  try {
    const result = await runTeamIdentityProof({ db: runtime.db, backendRoot: process.env.NOD_NATIVE_BACKEND_ROOT });
    fs.writeFileSync(path.join(process.env.NOD_AUDIT_NATIVE_OUTPUT, 'team-identity-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally { await runtime.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
