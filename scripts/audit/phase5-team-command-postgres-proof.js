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
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } } });
  const cases = [];
  const check = async (name, work) => {
    await work(); cases.push({ name, status: "PASS" }); console.log(JSON.stringify(cases.at(-1)));
  };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], {
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
        const agency = await tx.agency.create({ data: { name: key } });
        const actorMember = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: actorUser.id, role: "OWNER", roleKey: "owner", assignedCreators: "all", permissions: {} } });
        const member = await tx.agencyMember.create({ data: { agencyId: agency.id, userId: targetUser.id, role: "OPERATOR", roleKey: "chatter", assignedCreators: [], permissions: {} } });
        await tx.workerDevice.create({ data: { id: key + "-device", agencyId: agency.id, userId: actorUser.id } });
        await tx.workerDevice.create({ data: { id: key + "-target", agencyId: agency.id, userId: targetUser.id } });
        const invitation = await tx.agencyInvitation.create({ data: { agencyId: agency.id, tokenHash: key, roleKey: "chatter", invitedByUserId: actorUser.id, assignedCreators: [], expiresAt: new Date(Date.now() + 86400000) } });
        await tx.agencyCustomRole.create({ data: { agencyId: agency.id, key: "custom_proof", label: "Proof", access: {}, basedOn: "chatter" } });
        await tx.refreshSession.create({ data: { agencyId: agency.id, userId: actorUser.id, tokenHash: key + "-owner", deviceId: key + "-device", authorizationSessionId: key + "-lineage", expiresAt: new Date(Date.now() + 86400000) } });
        await tx.refreshSession.create({ data: { agencyId: agency.id, userId: targetUser.id, tokenHash: key + "-member", expiresAt: new Date(Date.now() + 86400000) } });
        return { key, agencyId: agency.id, actorUserId: actorUser.id, actorMember, member, invitation, db };
      });
    }
    async function snapshot(s) {
      const result = {};
      for (const table of ["AgencyMember", "TeamMemberFunction", "AgencyInvitation", "AgencyCustomRole", "AgencyRoleOverride", "AgencySubPermissionOverride", "RefreshSession", "AuditLog", "DeviceCommand"]) {
        result[table] = (await db.$queryRawUnsafe(`SELECT COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t."id"),'[]'::jsonb) AS rows FROM "${table}" t WHERE "agencyId"=$1`, s.agencyId))[0].rows;
      }
      return result;
    }
    const operations = [
      ["member settings", s => team.updateMemberSettings({ ...s, memberId: s.member.id, patch: { displayName: "Updated", functions: ["CHATTER"] } })],
      ["member status", s => team.setMemberStatus({ ...s, memberId: s.member.id, status: "deactivated" })],
      ["member removal", s => team.removeMember({ ...s, memberId: s.member.id })],
      ["invitation creation", s => team.createInvitation({ ...s, input: { roleKey: "chatter", assignedCreators: [] } })],
      ["invitation reissue", s => team.reissueInvitation({ ...s, invitationId: s.invitation.id })],
      ["invitation revocation", s => team.revokeInvitation({ ...s, invitationId: s.invitation.id })],
      ["role creation", s => team.createCustomRole({ ...s, input: { label: "New proof role", basedOn: "chatter" } })],
      ["role metadata", s => team.updateRoleMetadata({ ...s, roleKey: "custom_proof", input: { label: "Renamed" } })],
      ["role access", s => team.setRoleAccess({ ...s, roleKey: "chatter", zoneKey: "workspace", levelKey: "full" })],
      ["role permission", s => team.setRolePermission({ ...s, roleKey: "chatter", permissionKey: "workspace.manage_members", value: true })],
      ["role reset", s => team.resetRole({ ...s, roleKey: "chatter" })],
      ["role deletion", s => team.deleteCustomRole({ ...s, roleKey: "custom_proof" })],
    ];
    for (const [name, command] of operations) {
      const s = await seed();
      await check(`${name}: audit failure rolls back the complete actual command and hints`, async () => {
        const before = await snapshot(s);
        await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=true');
        try { await assert.rejects(() => command(s), /PHASE5_CONTROLLED_AUDIT_FAILURE/); }
        catch (error) { console.error("audit rejection proof failed", name, error); throw error; }
        finally { await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=false'); }
        assert.deepEqual(await snapshot(s), before);
        assert.equal((await events(s)).events.length, 0);
      });
      await check(`${name}: success commits exactly one mandatory audit`, async () => {
        await command(s);
        assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 1);
      });
    }
    function injectConflict(callback = null) {
      let attempts = 0;
      return {
        get attempts() { return attempts; },
        db: { $transaction: async (work, options) => {
          attempts += 1;
          try {
            return await db.$transaction(async tx => {
              const result = await work(tx);
              if (attempts === 1) await tx.$executeRawUnsafe("DO $$ BEGIN RAISE EXCEPTION 'proof serialization conflict' USING ERRCODE='40001'; END $$");
              return result;
            }, options);
          } catch (error) {
            if (attempts === 1 && callback) await callback();
            throw error;
          }
        } },
      };
    }
    await check("Team raw SQLSTATE retries whole command: one epoch, audit, and hint", async () => {
      const s = await seed(), retry = injectConflict();
      await team.setMemberStatus({ ...s, db: retry.db, memberId: s.member.id, status: "deactivated" });
      assert.equal(retry.attempts, 2);
      assert.equal((await db.agencyMember.findUnique({ where: { id: s.member.id } })).accessEpoch, 2);
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 1);
      assert.equal((await events(s)).events.length, 1);
    });
    await check("explicit Team join rejects a foreign agency or insufficient isolation", async () => {
      const s = await seed();
      for (const [options, code] of [
        [{ profile: "TEAM_MANAGEMENT", authority: { kind: "ADMIN_COMMAND", agencyId: "foreign" } }, "DB_COMMIT_JOIN_SCOPE_MISMATCH"],
        [{ profile: "ADMIN_COMMAND", authority: { kind: "ADMIN_COMMAND", agencyId: s.agencyId } }, "DB_COMMIT_JOIN_ISOLATION_MISMATCH"],
      ]) await assert.rejects(() => runRootCommit(db, context => team.setMemberStatus({ ...s, db: context.tx, commitContext: context, memberId: s.member.id, status: "deactivated" }), options), { code });
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 0);
    });
    // Call the actual Express domain handlers with a synthetic authenticated
    // request. This checks their transaction path, not HTTP authentication.
    for (const registration of [false, true]) await check(`${registration ? "registration" : "authenticated"} invitation claim cannot commit without its audit`, async () => {
      const s = await seed(), token = `phase5-invitation-${s.key}`;
      await db.$transaction(async tx => {
        await generation(tx);
        await tx.agencyInvitation.update({ where: { id: s.invitation.id }, data: { tokenHash: crypto.createHash("sha256").update(token).digest("hex") } });
      });
      const email = `${s.key}-claim@example.test`;
      const claimant = registration ? null : await db.user.create({ data: { email, passwordHash: "proof" } });
      const before = await snapshot(s), users = await db.user.count();
      const router = require(registration ? "../../src/routes/auth" : "../../src/routes/invitations");
      const handler = router.stack.find(layer => layer.route?.path === (registration ? "/register" : "/claim") && layer.route.methods.post).route.stack.at(-1).handle;
      const req = { body: registration ? { email, password: "local-proof-password", inviteToken: token } : { token }, auth: { userId: claimant?.id }, headers: {} };
      const res = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
      await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=true');
      try { await handler(req, res); }
      finally { await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=false'); }
      assert.equal(res.statusCode, 500, JSON.stringify(res.body));
      assert.equal(res.body.code, registration ? "REGISTER_FAILED" : "INVITE_CLAIM_FAILED");
      assert.deepEqual(await snapshot(s), before); assert.equal(await db.user.count(), users);
    });
    await check("role update with 1100 members uses one hint slot and isolates another agency", async () => {
      const s = await seed(), foreign = await seed();
      await db.$transaction(async tx => {
        await generation(tx);
        await tx.$executeRawUnsafe(`INSERT INTO "User" (id,email,"passwordHash","updatedAt") SELECT $1||':'||n,$1||':'||n||'@example.test','proof',now() FROM generate_series(1,1100) n`, s.key);
        await tx.$executeRawUnsafe(`INSERT INTO "AgencyMember" (id,"agencyId","userId",role,"roleKey","assignedCreators","updatedAt") SELECT $1||':'||n,$2,$1||':'||n,'OPERATOR','chatter','[]'::jsonb,now() FROM generate_series(1,1100) n`, s.key, s.agencyId);
      }, { timeout: 30000 });
      const before = await snapshot(foreign);
      await team.setRolePermission({ ...s, roleKey: "chatter", permissionKey: "workspace.manage_members", value: true });
      assert.equal(await db.agencyMember.count({ where: { agencyId: s.agencyId, roleKey: "chatter", accessEpoch: 2 } }), 1101);
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 1);
      assert.deepEqual(await snapshot(foreign), before);
    });
    const admin = await db.adminUser.create({ data: { email: "phase5-admin@example.test", passwordHash: "proof", role: "SUPER_ADMIN" } });
    const session = await db.adminSession.create({ data: { adminUserId: admin.id, tokenHash: "phase5-admin-proof", expiresAt: new Date(Date.now() + 86400000), issuedAccessEpoch: admin.accessEpoch } });
    const actor = { adminId: admin.id, sessionId: session.id, accessEpoch: admin.accessEpoch };
    const adminInput = (s, action = "member.remove") => ({ db, actor, commandId: crypto.randomUUID(), action, targetId: s.member.id, payload: { agencyId: s.agencyId, expectedAccessEpoch: 1, reason: "Phase5 proof", ...(action === "member.permissions.set" ? { permissions: {} } : {}) } });
    await check("Admin -> Team audit failure rolls back both receipts, membership and outbox", async () => {
      const s = await seed(), input = adminInput(s), before = await snapshot(s);
      await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=true');
      try { await assert.rejects(() => executeAdminOperation(input), /PHASE5_CONTROLLED_AUDIT_FAILURE/); }
      finally { await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=false'); }
      assert.deepEqual(await snapshot(s), before);
      assert.equal(await db.adminCommand.count({ where: { commandId: input.commandId } }), 0);
      assert.equal((await events(s)).events.length, 0);
    });
    await check("Admin raw SQLSTATE retries joined Team work once; replay adds no effect", async () => {
      const s = await seed(), input = adminInput(s), retry = injectConflict();
      const result = await executeAdminOperation({ ...input, db: retry.db });
      assert.equal(result.statusCode, 200); assert.equal(retry.attempts, 2);
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 1);
      assert.equal(await db.adminCommandAudit.count({ where: { command: { commandId: input.commandId } } }), 1);
      assert.equal(await db.deviceCommand.count({ where: { agencyId: s.agencyId } }), 1);
      assert.equal((await events(s)).events.length, 1);
      assert.equal((await executeAdminOperation(input)).replayed, true);
      assert.equal((await events(s)).events.length, 1);
      assert.equal(await db.deviceCommand.count({ where: { agencyId: s.agencyId } }), 1);
    });
    await check("Admin savepoint rejection commits receipt, discards partial domain and hints", async () => {
      const s = await seed(), input = adminInput(s, "member.permissions.set");
      let hints = 0;
      const result = await executeAdminCommand({ ...input, work: async ({ tx, commitContext }) => {
        await generation(tx);
        await tx.agencyMember.update({ where: { id: s.member.id }, data: { displayName: "Must roll back" } });
        deferCommitHint(commitContext, "rejected-proof", () => { hints += 1; });
        throw adminError("PROOF_DOMAIN_REJECTION", "Reject this intent", 409);
      } });
      assert.equal(result.statusCode, 409); assert.equal(hints, 0);
      assert.equal((await db.agencyMember.findUnique({ where: { id: s.member.id } })).displayName, null);
      assert.equal((await db.adminCommand.findUnique({ where: { actorId_commandId: { actorId: actor.adminId, commandId: input.commandId } } })).status, "REJECTED");
    });
    await check("Owner audit failure and raw-conflict retry preserve exactly one owner", async () => {
      const s = await seed(), before = await snapshot(s);
      const input = { db, agencyId: s.agencyId, userId: s.actorUserId, actorDeviceId: s.key + "-device", authorizationSessionId: s.key + "-lineage", input: { commandId: crypto.randomUUID(), memberId: s.member.id, expectedOwnerEpoch: 1, expectedTargetEpoch: 1, expectedRootVersion: null } };
      await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=true');
      try { await assert.rejects(() => owner.transferOwnership(input), /PHASE5_CONTROLLED_AUDIT_FAILURE/); }
      finally { await db.$executeRawUnsafe('UPDATE "Phase5AuditFault" SET enabled=false'); }
      assert.deepEqual(await snapshot(s), before);
      const retry = injectConflict();
      await owner.transferOwnership({ ...input, db: retry.db });
      assert.equal(retry.attempts, 2);
      assert.deepEqual((await db.agencyMember.findMany({ where: { agencyId: s.agencyId, roleKey: "owner" } })).map(m => m.id), [s.member.id]);
      assert.equal(await db.auditLog.count({ where: { agencyId: s.agencyId } }), 1);
      assert.equal(await db.deviceCommand.count({ where: { agencyId: s.agencyId } }), 2);
    });
    await check("Admin authority is re-read after rollback, never replayed from first attempt", async () => {
      const s = await seed(), before = await snapshot(s), input = adminInput(s);
      const retry = injectConflict(() => db.adminSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } }));
      await assert.rejects(() => executeAdminOperation({ ...input, db: retry.db }), e => e.code === "ADMIN_AUTH_INVALID");
      assert.equal(retry.attempts, 2); assert.deepEqual(await snapshot(s), before);
      assert.equal(await db.adminCommand.count({ where: { commandId: input.commandId } }), 0);
      assert.equal((await events(s)).events.length, 0);
    });
    const result = { ok: true, prisma: Prisma.prismaVersion.client, fullMigrationChain: true, nativeConcurrentPostgres: false, engine: "PGlite PostgreSQL WASM via Prisma TCP", cases };
    if (process.env.PHASE5_PROOF_OUTPUT) fs.writeFileSync(process.env.PHASE5_PROOF_OUTPUT, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ok: true, passed: cases.length }));
  } finally {
    await db.$disconnect(); await server.stop(); await engine.close();
  }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { main };
