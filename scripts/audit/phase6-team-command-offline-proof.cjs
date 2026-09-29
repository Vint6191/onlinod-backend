"use strict";
// Disposable full migration chain + actual application Prisma/services. Never
// connects to DATABASE_URL. Fault injection is deterministic, not native load.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const { spawn } = require("node:child_process");
const { PrismaClient, Prisma } = require("@prisma/client");
const root = path.resolve(__dirname, "../..");

async function main() {
  if (!process.env.PHASE5_PROOF_RUNTIME) throw new Error("PHASE5_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite");
  const { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  console.log("PROOF_ENGINE_START");
  const engine = await PGlite.create();
  console.log("PROOF_ENGINE_READY");
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  console.log("PROOF_SOCKET_READY");
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const cases = [];
  const check = async (name, work) => {
    await work(); cases.push({ name, status: "PASS" }); console.log(JSON.stringify(cases.at(-1)));
  };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
        cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", b => { output += b; }); child.stderr.on("data", b => { output += b; });
      child.once("error", reject); child.once("close", code => code ? reject(new Error(output)) : resolve());
    });
    await engine.exec("DISCARD ALL");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE';
      CREATE TABLE "Phase5AuditFault" (enabled boolean NOT NULL);
      INSERT INTO "Phase5AuditFault" VALUES (false);
      CREATE FUNCTION phase5_fail_required_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF (SELECT enabled FROM "Phase5AuditFault") THEN RAISE EXCEPTION 'PHASE5_CONTROLLED_AUDIT_FAILURE'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER phase5_audit_fault BEFORE INSERT ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION phase5_fail_required_audit();`);
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const team = require("../../src/services/team-administration-service");
    const owner = require("../../src/services/team-ownership-transfer-service");
    const { executeAdminOperation } = require("../../src/services/admin-operational-command-service");
    const { executeAdminCommand } = require("../../src/services/admin-commit-authority-service");
    const { adminError } = require("../../src/services/admin-command-contract");
    const { runRootCommit, deferCommitHint } = require("../../src/services/db-commit-kernel");
    const { waitForDesktopControlEvents } = require("../../src/services/desktop-control-events");
    const events = s => waitForDesktopControlEvents({ agencyId: s.agencyId, userId: s.member.userId, memberId: s.member.id, streamId: "proof-other-stream" });
    const generation = tx => tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", "phase2_team_control_plane_v2_durable_access");
    let serial = 0;
    async function seed() {
      const key = `proof-${++serial}`;
      return db.$transaction(async tx => {
        await generation(tx);
        const actorUser = await tx.user.create({ data: { email: `${key}-owner@example.test`, passwordHash: "proof" } });
        const targetUser = await tx.user.create({ data: { email: `${key}-member@example.test`, passwordHash: "proof" } });
        const agency = await tx.agency.create({ data: { name: key, trialEndsAt: new Date("2099-01-01") } });
        const actorMember = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: actorUser.id, role: "OWNER", roleKey: "owner", assignedCreators: "all", permissions: {} } });
        const creator = await tx.creatorAccount.create({ data: { agencyId: agency.id, displayName: key } });
        const member = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: targetUser.id, role: "OPERATOR", roleKey: "chatter", assignedCreators: [creator.id], permissions: {} } });
        await tx.workerDevice.create({ data: { id: key + "-device", agencyId: agency.id, userId: actorUser.id } });
        await tx.workerDevice.create({ data: { id: key + "-target", agencyId: agency.id, userId: targetUser.id } });
        const invitation = await tx.agencyInvitation.create({ data: { agencyId: agency.id, tokenHash: key, roleKey: "chatter", invitedByUserId: actorUser.id, assignedCreators: [], expiresAt: new Date(Date.now() + 86400000) } });
        await tx.agencyCustomRole.create({ data: { agencyId: agency.id, key: "custom_proof", label: "Proof", access: {}, basedOn: "chatter" } });
        await tx.refreshSession.create({ data: { agencyId: agency.id, userId: actorUser.id, tokenHash: key + "-owner", deviceId: key + "-device", authorizationSessionId: key + "-lineage", expiresAt: new Date(Date.now() + 86400000) } });
        await tx.refreshSession.create({ data: { agencyId: agency.id, userId: targetUser.id, tokenHash: key + "-member", expiresAt: new Date(Date.now() + 86400000) } });
        return { key, creator, agencyId: agency.id, actorUserId: actorUser.id, actorMember, member, invitation, db };
      });
    }
    async function snapshot(s) {
      const result = {};
      for (const table of ["AgencyMember", "TeamMemberFunction", "AgencyInvitation", "AgencyCustomRole", "AgencyRoleOverride", "AgencySubPermissionOverride", "RefreshSession", "AuditLog", "DeviceCommand", "TeamShift", "TeamMutationReceipt"]) {
        result[table] = (await db.$queryRawUnsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."id"),'[]'::jsonb) AS rows FROM "${table}" t WHERE "agencyId"=$1`, s.agencyId))[0].rows;
      }
      return result;
    }
    const { executeTeamCommand } = require("../../src/services/team-command-service");
    const cmd = (s, action, targetId = "", payload = {}) => ({ db, agencyId: s.agencyId, userId: s.actorUserId, input: { commandId: crypto.randomUUID(), action, targetId, payload } });
    const shiftInput = s => ({ memberId: s.member.id, creatorIds: [s.creator.id], startsAt: "2026-10-01T10:00:00.000Z", endsAt: "2026-10-01T12:00:00.000Z", timezone: "UTC" });
    const actions = [
      ["member.update", s => [s.member.id, { displayName: "Updated", functions: ["CHATTER"] }]],
      ["member.status", s => [s.member.id, { status: "deactivated" }]],
      ["member.remove", s => [s.member.id, {}]],
      ["invitation.create", s => ["", { email: "invite@example.test", assignedCreators: [s.creator.id] }]],
      ["invitation.reissue", s => [s.invitation.id, {}]],
      ["invitation.revoke", s => [s.invitation.id, {}]],
      ["role.create", () => ["", { label: "New replay role" }]],
      ["role.update", () => ["custom_proof", { label: "Renamed" }]],
      ["role.access", () => ["chatter", { zoneKey: "workspace", levelKey: "full" }]],
      ["role.permission", () => ["chatter", { permissionKey: "workspace.manage_members", value: true }]],
      ["role.reset", () => ["chatter", {}]],
      ["role.delete", () => ["custom_proof", {}]],
      ["shift.create", s => ["", shiftInput(s)]],
      ["shift.update", async s => { const created = await executeTeamCommand(cmd(s, "shift.create", "", shiftInput(s))); return [created.shiftId, { expectedRevision: 1, note: "Updated" }]; }],
      ["shift.cancel", async s => { const created = await executeTeamCommand(cmd(s, "shift.create", "", shiftInput(s))); return [created.shiftId, { expectedRevision: 1 }]; }],
    ];
    for (const [action, make] of actions) {
      const s = await seed(), request = cmd(s, action, ...await make(s));
      await check(action + ": mandatory audit failure rolls back domain + receipt", async () => {
        const before = await snapshot(s);
        await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=true');
        try { await assert.rejects(() => executeTeamCommand(request), /PHASE5_CONTROLLED_AUDIT_FAILURE/); }
        finally { await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=false'); }
        assert.deepEqual(await snapshot(s), before);
      });
      await check(action + ": replay returns original result without revision, epoch, audit or effect changes", async () => {
        const first = await executeTeamCommand(request), before = await snapshot(s);
        const replay = await executeTeamCommand(request);
        assert.equal(first.replayed, false); assert.deepEqual(replay, { ...first, replayed: true });
        assert.deepEqual(await snapshot(s), before);
      });
    }
    await check("receipt insert failure rolls back role, audit and whole command", async () => {
      const s = await seed(), request = cmd(s, "role.create", "", { label: "Receipt fault" }), before = await snapshot(s);
      await db.$executeRawUnsafe(`CREATE FUNCTION phase6_fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'D2_RECEIPT_FAULT'; END $$`);
      await db.$executeRawUnsafe(`CREATE TRIGGER phase6_receipt_fault BEFORE INSERT ON "TeamMutationReceipt" FOR EACH ROW EXECUTE FUNCTION phase6_fail_receipt()`);
      try { await assert.rejects(() => executeTeamCommand(request), /D2_RECEIPT_FAULT/); }
      finally { await db.$executeRawUnsafe('DROP TRIGGER phase6_receipt_fault ON "TeamMutationReceipt"'); }
      assert.deepEqual(await snapshot(s), before);
    });
    await check("changed intent under same command ID fails without changes", async () => {
      const s = await seed(), request = cmd(s, "role.create", "", { label: "Original" });
      await executeTeamCommand(request); const before = await snapshot(s);
      await assert.rejects(() => executeTeamCommand({ ...request, input: { ...request.input, payload: { label: "Changed" } } }), { code: "TEAM_COMMAND_INTENT_MISMATCH" });
      assert.deepEqual(await snapshot(s), before);
    });
    await check("abandon tombstone fences delayed original request and is repeatable", async () => {
      const s = await seed(), request = cmd(s, "role.create", "", { label: "Delayed" });
      assert.equal((await executeTeamCommand({ ...request, cancel: true })).abandoned, true);
      const before = await snapshot(s);
      await assert.rejects(() => executeTeamCommand(request), { code: "TEAM_COMMAND_ABANDONED" });
      assert.equal((await executeTeamCommand({ ...request, cancel: true })).abandoned, true);
      assert.deepEqual(await snapshot(s), before);
    });
    await check("cancel after commit reports committed and does not undo the action", async () => {
      const s = await seed(), request = cmd(s, "role.create", "", { label: "Committed" });
      await executeTeamCommand(request); const before = await snapshot(s);
      assert.equal((await executeTeamCommand({ ...request, cancel: true })).alreadyCommitted, true);
      assert.deepEqual(await snapshot(s), before);
    });
    await check("invitation recovery stores no plaintext secret; reissue supersedes old replay", async () => {
      const s = await seed(), request = cmd(s, "invitation.create", "", { assignedCreators: [s.creator.id] });
      const first = await executeTeamCommand(request);
      assert.equal(first.linkAvailable, true);
      const receipt = JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "TeamMutationReceipt" WHERE "agencyId"=$1', s.agencyId));
      const audits = JSON.stringify(await db.auditLog.findMany({ where: { agencyId: s.agencyId } }));
      assert.equal(receipt.includes(first.token), false); assert.equal(audits.includes(first.token), false);
      await executeTeamCommand(cmd(s, "invitation.reissue", first.invitation.id));
      const replay = await executeTeamCommand(request); assert.equal(replay.url, null); assert.equal(replay.token, null); assert.equal(replay.linkAvailable, false);
    });
    await check("key rotation acknowledges old invitation without creating or rotating it", async () => {
      const s = await seed(), request = cmd(s, "invitation.create", "", {});
      await executeTeamCommand(request); const before = await snapshot(s), secret = process.env.JWT_SECRET;
      process.env.JWT_SECRET = "d2-another-local-proof-secret";
      try { assert.equal((await executeTeamCommand(request)).linkAvailable, false); }
      finally { process.env.JWT_SECRET = secret; }
      assert.deepEqual(await snapshot(s), before);
    });
    await check("replay denied after actor disable", async () => {
      const s = await seed(), request = cmd(s, "role.create", "", { label: "Before revoke" });
      await executeTeamCommand(request);
      await db.$transaction(async tx => { await generation(tx);
        await tx.agencyMember.update({ where: { id: s.actorMember.id }, data: { role: "OPERATOR", roleKey: "chatter" } });
        await tx.agencyMember.update({ where: { id: s.member.id }, data: { role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
        await tx.user.update({ where: { id: s.actorUserId }, data: { disabledAt: new Date() } }); });
      assert.ok((await db.user.findUnique({ where: { id: s.actorUserId } })).disabledAt, "fixture disable must persist");
      await assert.rejects(() => executeTeamCommand(request), { code: "MANAGEMENT_USER_DISABLED" });
    });
    await check("same UUID is isolated by user and agency", async () => {
      const a = await seed(), b = await seed(), request = cmd(a, "role.create", "", { label: "Isolation" });
      const first = await executeTeamCommand(request);
      const second = await executeTeamCommand({ ...request, agencyId: b.agencyId, userId: b.actorUserId });
      assert.notEqual(first.role.key, second.role.key); assert.equal(second.replayed, false);
    });
    await check("whole Serializable root retries domain and receipt after injected 40001", async () => {
      const s = await seed(), request = cmd(s, "role.create", "", { label: "Retry root" });
      let attempts = 0;
      const wrapped = { $transaction: (fn, options) => db.$transaction(async tx => {
        attempts++; const result = await fn(tx);
        if (attempts === 1) await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION 'controlled conflict' USING ERRCODE='40001'; END $$");
        return result;
      }, options) };
      await executeTeamCommand({ ...request, db: wrapped }); assert.equal(attempts, 2);
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 1);
      assert.equal((await db.$queryRawUnsafe('SELECT * FROM "TeamMutationReceipt" WHERE "agencyId"=$1', s.agencyId)).length, 1);
    });
    await check("replay checks fresh permission and creator scope after actor changes", async () => {
      for (const scopeLoss of [false, true]) {
        const s = await seed(), request = cmd(s, "invitation.create", "", { assignedCreators: [s.creator.id] });
        await executeTeamCommand(request);
        await db.$transaction(async tx => { await generation(tx); await tx.agencyMember.update({ where: { id: s.actorMember.id }, data: {
          role: "OPERATOR", roleKey: "chatter", assignedCreators: scopeLoss ? [] : [s.creator.id], permissions: { "workspace.invite": scopeLoss },
        } });
          await tx.agencyMember.update({ where: { id: s.member.id }, data: { role: "OWNER", roleKey: "owner", assignedCreators: "all" } });
        });
        assert.equal((await db.agencyMember.findUnique({ where: { id: s.actorMember.id } })).role, "OPERATOR");
        await assert.rejects(() => executeTeamCommand(request), { code: scopeLoss ? "MANAGEMENT_CREATOR_SCOPE_REVOKED" : "MANAGEMENT_PERMISSION_REVOKED" });
      }
    });
    await check("billing loss blocks shift replay without changing original receipt", async () => {
      const s = await seed(), request = cmd(s, "shift.create", "", shiftInput(s));
      await executeTeamCommand(request);
      await db.agency.update({ where: { id: s.agencyId }, data: { trialEndsAt: new Date("2000-01-01") } });
      const before = await snapshot(s);
      await assert.rejects(() => executeTeamCommand(request), error => [402, 403].includes(error.status));
      assert.deepEqual(await snapshot(s), before);
    });
    await check("new stale shift intent fails while old committed intent still replays", async () => {
      const s = await seed(), first = cmd(s, "shift.create", "", shiftInput(s));
      const created = await executeTeamCommand(first);
      const update = cmd(s, "shift.update", created.shiftId, { expectedRevision: 1, note: "One update" });
      await executeTeamCommand(update); const before = await snapshot(s);
      await assert.rejects(() => executeTeamCommand({ ...update, input: { ...update.input, commandId: crypto.randomUUID() } }), { code: "STALE_COMMAND_TARGET" });
      assert.equal((await executeTeamCommand(first)).revision, 1);
      assert.deepEqual(await snapshot(s), before);
    });
    await check("receipt lookup stays a primary-key lookup with 16000 prior receipts", async () => {
      const s = await seed(), request = cmd(s, "role.create", "", { label: "Indexed receipt" });
      await executeTeamCommand(request);
      await db.$executeRawUnsafe(`INSERT INTO "TeamMutationReceipt" (id,"agencyId","userId",action,"targetId",fingerprint,status,result,"authorizationScope")
        SELECT $1||':'||n,$2,$3,'role.create','','fixture','ABANDONED','{}'::jsonb,'{}'::jsonb FROM generate_series(1,16000) n`, s.key, s.agencyId, s.actorUserId);
      await db.$executeRawUnsafe('ANALYZE "TeamMutationReceipt"');
      const id = "team_v2_" + require("../../src/services/team-command-contract").digest([s.agencyId, s.actorUserId, request.input.commandId]);
      const plan = await db.$queryRawUnsafe('EXPLAIN (FORMAT JSON) SELECT * FROM "TeamMutationReceipt" WHERE id=$1', id);
      assert.match(JSON.stringify(plan), /TeamMutationReceipt_pkey/);
      assert.equal((await executeTeamCommand(request)).replayed, true);
      const { purgeAgencyNonFkTenantBatch } = require("../../src/services/phase2-destructive-delete-authority-service");
      const before = await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "TeamMutationReceipt" WHERE "agencyId"=$1', s.agencyId);
      const foreign = await seed(), foreignRequest = cmd(foreign, "role.create", "", { label: "Foreign receipt" });
      await executeTeamCommand(foreignRequest);
      const deleted = await db.$transaction(tx => purgeAgencyNonFkTenantBatch({ tx, agencyId: s.agencyId, limit: 2 }));
      assert.equal(deleted.deleted, 2);
      const after = await db.$queryRawUnsafe('SELECT count(*)::int AS n FROM "TeamMutationReceipt" WHERE "agencyId"=$1', s.agencyId);
      assert.equal(before[0].n - after[0].n, 2);
      assert.equal((await executeTeamCommand(foreignRequest)).replayed, true);
    });
    await check("new Prisma client and freshly loaded service recover committed command", async () => {
      const s = await seed(), request = cmd(s, "role.create", "", { label: "Restart" });
      const first = await executeTeamCommand(request);
      await db.$disconnect();
      const freshDb = new PrismaClient({ datasources: { db: { url } } });
      const modulePath = require.resolve("../../src/services/team-command-service"); delete require.cache[modulePath];
      try { const replay = await require(modulePath).executeTeamCommand({ ...request, db: freshDb }); assert.deepEqual(replay, { ...first, replayed: true }); }
      finally { await freshDb.$disconnect(); }
    });
    console.log(JSON.stringify({ status: "PASS", cases: cases.length, actualPrisma: true, fullMigrationChain: true, physicalMultiSessionPostgres: false }));
  } finally { await db.$disconnect(); await server.stop(); await engine.close(); }
}
const keepAlive = setInterval(() => {}, 1000);
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => clearInterval(keepAlive));
