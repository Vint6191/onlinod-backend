"use strict";
// Disposable full-migration SQL proof. Does not use the caller's DATABASE_URL.
const assert = require("node:assert/strict"),
  path = require("node:path"),
  crypto = require("node:crypto");
const { createRequire } = require("node:module"),
  { spawn } = require("node:child_process");
const { PrismaClient } = require(process.env.D8_PRISMA_CLIENT || "@prisma/client");
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => {
  console.error("LOCAL_PROOF_DEADLINE");
  process.exit(2);
}, 180000);
async function main() {
  if (!process.env.PHASE5_PROOF_RUNTIME) throw Error("PHASE5_PROOF_RUNTIME required");
  const load = createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME, "package.json"));
  const { PGlite } = load("@electric-sql/pglite"),
    { PGLiteSocketServer } = load("@electric-sql/pglite-socket");
  console.log("PROOF_ENGINE_START");
  const engine = await PGlite.create();
  console.log("PROOF_ENGINE_READY");
  const server = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
  await server.start();
  console.log("PROOF_SOCKET_READY");
  const url = `postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db = new PrismaClient({ datasources: { db: { url } }, log: [{ emit: "event", level: "query" }] }),
    cases = [];
  if (process.env.D8_SQL_TRACE === "1") db.$on("query", (e) => console.log("SQL", e.query.slice(0, 150)));
  const check = async (name, work) => {
    console.log("CHECK_START", name);
    await work();
    cases.push({ name, status: "PASS" });
    console.log(JSON.stringify(cases.at(-1)));
  };
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [require.resolve("prisma/build/index.js"), "migrate", "deploy"], {
        cwd: path.resolve(__dirname, "../.."),
        env: { ...process.env, DATABASE_URL: url },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (b) => { output += b; console.log("MIGRATION", String(b).slice(0,500)); });
      child.stderr.on("data", (b) => { output += b; console.log("MIGRATION_ERR", String(b).slice(0,500)); });
      child.once("error", reject);
      child.once("close", (code) => (code ? reject(Error(output)) : resolve()));
    });
    console.log("PROOF_MIGRATIONS_APPLIED");
    await engine.exec("DISCARD ALL");
    console.log("PROOF_WIRE_RESET");
    await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`CREATE TABLE "D8AuditFault" (enabled boolean NOT NULL); INSERT INTO "D8AuditFault" VALUES(false);
      CREATE FUNCTION d7_receipt_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF (SELECT enabled FROM "D8AuditFault") THEN RAISE EXCEPTION 'D8_RECEIPT_FAULT'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER d7_receipt_fault BEFORE INSERT ON "ManagementCommandReceipt" FOR EACH ROW EXECUTE FUNCTION d7_receipt_fault();
      CREATE TABLE "D8PasswordFault" (enabled boolean NOT NULL); INSERT INTO "D8PasswordFault" VALUES(false);
      CREATE FUNCTION d8_password_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW."passwordHash" IS DISTINCT FROM OLD."passwordHash" AND (SELECT enabled FROM "D8PasswordFault") THEN RAISE EXCEPTION 'D8_PASSWORD_FAULT'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER d8_password_fault BEFORE UPDATE ON "User" FOR EACH ROW EXECUTE FUNCTION d8_password_fault();`);
    Object.assign(process.env, {
      NOWPAYMENTS_MODE: "sandbox",
      NOWPAYMENTS_API_KEY: "synthetic",
      NOWPAYMENTS_IPN_SECRET: "synthetic",
      PUBLIC_BASE_URL: "https://backend.test",
      NOWPAYMENTS_SANDBOX_ACTIVATE: "true",
    });
    global.fetch = async () => {
      throw Error("D8 proof forbids external services");
    };
    console.log("PROOF_FIXTURE_DDL_READY");
    require.cache[require.resolve("../../src/prisma")] = { exports: db };
    const emails=[];
    require.cache[require.resolve('../../src/services/email-service')]={exports:{passwordResetEmail:async input=>{emails.push(input);return {ok:true};},verificationEmail:async()=>({ok:true})}};
    const { executeAccountSecurityCommand: execute } = require('../../src/services/account-security-command-service');
    const { sessionRevision, selectSessions, readActiveSessions } = require('../../src/services/account-security-state');
    const { resetAccountPassword } = require('../../src/services/account-password-reset-service');
    const auth = require('../../src/services/auth-service'), settings = require('../../src/services/settings-service');
    const { authorizeAuthorizationHistoryPublisher } = require('../../src/services/authorization-history-write-contract');
    const bcrypt = require('bcryptjs');
    const oldHash = await bcrypt.hash('original-password', 4);
    let seq=0;
    const generation = tx => tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)", 'phase2_team_control_plane_v2_durable_access');
    async function addSession(s, deviceId='other', lineage=crypto.randomUUID(), extras={}) {
      return db.$transaction(async tx => {
        await authorizeAuthorizationHistoryPublisher(tx);
        return tx.refreshSession.create({data:{userId:s.userId,agencyId:s.agencyId,deviceId,authorizationSessionId:lineage,
          tokenHash:crypto.randomBytes(32).toString('hex'),expiresAt:new Date('2099-01-01'),...extras}});
      });
    }
    async function seed() {
      const s=await db.$transaction(async tx=>{
        await generation(tx);
        const user=await tx.user.create({data:{email:`d8-${++seq}@example.test`,passwordHash:oldHash,emailVerifiedAt:new Date()}});
        const agency=await tx.agency.create({data:{name:`d8-${seq}`,trialEndsAt:new Date('2099-01-01')}});
        const member=await tx.agencyMember.create({data:{userId:user.id,agencyId:agency.id,role:'OWNER',roleKey:'owner',assignedCreators:'all'}});
        return {userId:user.id,agencyId:agency.id,member,deviceId:'current',authorizationSessionId:crypto.randomUUID()};
      });
      s.current=await addSession(s,s.deviceId,s.authorizationSessionId);s.other=await addSession(s);return s;
    }
    const run=(s,input,extra={})=>execute({db,...s,actorMember:s.member,input,...extra});
    const active=s=>readActiveSessions(db,s.userId,new Date());
    async function command(s,action='account.logoutOthers',targetId='',patch={}) {
      const rows=await active(s);
      return {commandId:crypto.randomUUID(),action,targetId,payload:{deviceId:s.deviceId,originAuthorizationSessionId:s.authorizationSessionId,
        ...(action==='account.password'?{currentPassword:'original-password',newPassword:'replacement-password'}:{expectedRevision:sessionRevision(selectSessions(rows,action,targetId,s.deviceId))}),...patch}};
    }
    const row=id=>db.refreshSession.findUnique({where:{id}});
    const receipts=s=>db.$queryRawUnsafe('SELECT * FROM "ManagementCommandReceipt" WHERE "agencyId"=$1',s.agencyId);
    async function resetToken(s,extras={}) {
      const token=crypto.randomBytes(32).toString('hex');
      const value=await db.authToken.create({data:{userId:s.userId,type:'PASSWORD_RESET',tokenHash:crypto.createHash('sha256').update(token).digest('hex'),expiresAt:new Date('2099-01-01'),...extras}});
      return {token,row:value};
    }
    for(const action of ['account.logoutOthers','account.logoutDevice','account.revokeSession','account.revokeOthers']) await check(`${action}: commit/replay do not revoke a subsequent login`,async()=>{
      const s=await seed(), target=action==='account.logoutDevice'?'other':action==='account.revokeSession'?s.other.id:'';
      const c=await command(s,action,target), first=await run(s,c);
      assert.equal(first.result.revokedSessionCount,1); assert.ok((await row(s.other.id)).revokedAt);
      const fresh=await addSession(s,'other');
      const replay=await run(s,c);assert.equal(replay.replayed,true);assert.deepEqual(replay.result,first.result);
      assert.equal((await row(fresh.id)).revokedAt,null);assert.equal((await receipts(s)).length,1);
    });
    await check('password: lost acknowledgement replay, later password and login survive',async()=>{
      const s=await seed(),t=await resetToken(s),c=await command(s,'account.password');
      await run(s,c);
      assert.ok(await bcrypt.compare('replacement-password',(await db.user.findUnique({where:{id:s.userId}})).passwordHash));
      assert.ok((await db.authToken.findUnique({where:{id:t.row.id}})).usedAt);assert.equal((await row(s.current.id)).revokedAt,null);
      const fresh=await addSession(s,'other');
      const next=await command(s,'account.password','',{currentPassword:'replacement-password',newPassword:'latest-password'});await run(s,next);
      const newest=await addSession(s,'other');const replay=await run(s,c);
      assert.equal(replay.replayed,true);assert.ok(await bcrypt.compare('latest-password',(await db.user.findUnique({where:{id:s.userId}})).passwordHash));
      assert.equal((await row(newest.id)).revokedAt,null);assert.ok((await row(fresh.id)).revokedAt);
      const serialized=JSON.stringify(await receipts(s));assert.ok(!serialized.includes('passwordHash')&&!serialized.includes('original-password')&&!serialized.includes('replacement-password'));
    });
    await check('receipt insert failure rolls back password, sessions, reset token and audit',async()=>{
      const s=await seed(),t=await resetToken(s),c=await command(s,'account.password');
      await db.$executeRawUnsafe('UPDATE "D8AuditFault" SET enabled=true');
      try {await assert.rejects(run(s,c));}finally{await db.$executeRawUnsafe('UPDATE "D8AuditFault" SET enabled=false');}
      assert.equal((await db.user.findUnique({where:{id:s.userId}})).passwordHash,oldHash);
      assert.equal((await row(s.other.id)).revokedAt,null);assert.equal((await db.authToken.findUnique({where:{id:t.row.id}})).usedAt,null);
      assert.equal(await db.auditLog.count({where:{agencyId:s.agencyId}}),0);assert.equal((await receipts(s)).length,0);
    });
    await check('stale device snapshot rejects a new sign-in before first execution',async()=>{
      const s=await seed(),c=await command(s,'account.logoutDevice','other'),fresh=await addSession(s,'other');
      await assert.rejects(run(s,c),{code:'ACCOUNT_SECURITY_SESSION_CHANGED'});
      assert.equal((await row(fresh.id)).revokedAt,null);assert.equal((await row(s.other.id)).revokedAt,null);
    });
    await check('stale all-others snapshot rejects before any revocation',async()=>{
      const s=await seed(),c=await command(s);await addSession(s,'new-device');
      await assert.rejects(run(s,c),{code:'ACCOUNT_SECURITY_SESSION_CHANGED'});assert.equal((await row(s.other.id)).revokedAt,null);
    });
    await check('ordinary refresh rotation preserves the displayed revision',async()=>{
      const s=await seed(),c=await command(s,'account.logoutDevice','other');
      const replacement=await addSession(s,'other',s.other.authorizationSessionId);
      await db.refreshSession.update({where:{id:s.other.id},data:{revokedAt:new Date()}});
      await run(s,c);assert.ok((await row(replacement.id)).revokedAt);
    });
    await check('command fingerprint rejects UUID reuse with another target or secret',async()=>{
      const s=await seed(),c=await command(s);await run(s,c);
      await assert.rejects(run(s,{...c,payload:{...c.payload,expectedRevision:'0'.repeat(64)}}),{code:'ACCOUNT_SECURITY_COMMAND_CONFLICT'});
    });
    await check('cancel before commit prevents delayed execution',async()=>{
      const s=await seed(),c=await command(s);assert.equal((await run(s,c,{cancel:true})).abandoned,true);
      await assert.rejects(run(s,c),{code:'ACCOUNT_SECURITY_COMMAND_ABANDONED'});assert.equal((await row(s.other.id)).revokedAt,null);
    });
    await check('cancel after commit confirms event without undo',async()=>{
      const s=await seed(),c=await command(s);await run(s,c);assert.equal((await run(s,c,{cancel:true})).alreadyCommitted,true);
      assert.ok((await row(s.other.id)).revokedAt);
    });
    await check('revocation after admission blocks a still-active user at commit',async()=>{
      const s=await seed(),c=await command(s);await db.refreshSession.update({where:{id:s.current.id},data:{revokedAt:new Date()}});
      await assert.rejects(run(s,c),{code:'SESSION_REVOKED'});assert.equal((await row(s.other.id)).revokedAt,null);
    });
    await check('different live login may confirm prior self-logout without killing itself',async()=>{
      const s=await seed(),c=await command(s,'account.logoutDevice','current');const first=await run(s,c);assert.equal(first.result.currentDeviceLoggedOut,true);
      const next=crypto.randomUUID(),newLogin=await addSession(s,'current',next);
      const replay=await run({...s,authorizationSessionId:next},c);assert.equal(replay.replayed,true);
      assert.equal(replay.result.originAuthorizationSessionId,s.authorizationSessionId);assert.equal((await row(newLogin.id)).revokedAt,null);
    });
    await check('uncommitted intent cannot execute under a replacement login, but can be cancelled',async()=>{
      const s=await seed(),c=await command(s),next=crypto.randomUUID();await addSession(s,'current',next);
      await assert.rejects(run({...s,authorizationSessionId:next},c),{code:'ACCOUNT_SECURITY_ORIGIN_CHANGED'});
      assert.equal((await run({...s,authorizationSessionId:next},c,{cancel:true})).abandoned,true);
    });
    await check('membership epoch change rejects commit and receipt replay',async()=>{
      const s=await seed(),c=await command(s);await run(s,c);
      await db.$transaction(async tx=>{await generation(tx);await tx.agencyMember.update({where:{id:s.member.id},data:{accessEpoch:{increment:1}}});});
      await assert.rejects(run(s,c),{code:'MANAGEMENT_ACCESS_STALE'});
    });
    await check('disabled actor cannot use a pending command',async()=>{
      const s=await seed(),c=await command(s);
      await db.$transaction(async tx=>{
        await generation(tx);await tx.agencyMember.update({where:{id:s.member.id},data:{role:'ADMIN',roleKey:'admin'}});
        const u=await tx.user.create({data:{email:`owner-${s.userId}@example.test`,passwordHash:oldHash}});
        await tx.agencyMember.create({data:{userId:u.id,agencyId:s.agencyId,role:'OWNER',roleKey:'owner',assignedCreators:'all'}});
        await tx.user.update({where:{id:s.userId},data:{disabledAt:new Date()}});
      });
      await assert.rejects(run(s,c),{code:'MANAGEMENT_USER_DISABLED'});assert.equal((await row(s.other.id)).revokedAt,null);
    });
    await check('account settings versions match command scope including another agency',async()=>{
      const s=await seed(),other=await seed();await db.$transaction(async tx=>{await generation(tx);await tx.agencyMember.create({data:{userId:s.userId,agencyId:other.agencyId,role:'OPERATOR',roleKey:'chatter'}});});await addSession(s,'other',crypto.randomUUID(),{agencyId:other.agencyId});
      const data=await settings.getAccountSettings({db,userId:s.userId,currentDeviceId:s.deviceId});
      const c=await command(s);assert.equal(data.otherDevicesRevision,c.payload.expectedRevision);
      assert.equal(data.devices.find(d=>d.deviceId==='other').activeSessionCount,2);await run(s,c);
      assert.equal((await active(s)).length,1);
    });
    await check('password rejects incorrect current credential with no side effect',async()=>{
      const s=await seed(),c=await command(s,'account.password','',{currentPassword:'incorrect-password'});
      await assert.rejects(run(s,c),{code:'SETTINGS_CURRENT_PASSWORD_INVALID'});assert.equal((await receipts(s)).length,0);assert.equal((await row(s.other.id)).revokedAt,null);
    });
    await check('password reset consumes once; concurrent requests cannot both commit',async()=>{
      const s=await seed(),t=await resetToken(s),other=await resetToken(s);
      const result=await Promise.allSettled(['reset-first-password','reset-second-password'].map(password=>resetAccountPassword({db,token:t.token,password})));
      assert.equal(result.filter(r=>r.status==='fulfilled').length,1);assert.equal(result.filter(r=>r.status==='rejected').length,1);
      assert.ok((await db.authToken.findUnique({where:{id:other.row.id}})).usedAt);assert.ok((await row(s.current.id)).revokedAt);assert.ok((await row(s.other.id)).revokedAt);
      assert.ok((await db.user.findUnique({where:{id:s.userId}})).sessionsRevokedAt);
    });
    await check('expired reset token is rejected using database time',async()=>{
      const s=await seed(),t=await resetToken(s,{expiresAt:new Date('2000-01-01')});
      await assert.rejects(resetAccountPassword({db,token:t.token,password:'expired-password'}),{code:'TOKEN_EXPIRED'});assert.equal((await row(s.current.id)).revokedAt,null);
    });
    await check('password change invalidates every older unused reset token',async()=>{
      const s=await seed(),t=await resetToken(s);await run(s,await command(s,'account.password'));
      await assert.rejects(resetAccountPassword({db,token:t.token,password:'stale-reset-password'}),{code:'TOKEN_USED'});
    });
    await check('delayed logout with an old refresh token cannot revoke a new lineage',async()=>{
      const s=await seed(),token='synthetic-old-token-'+seq;
      await db.refreshSession.update({where:{id:s.other.id},data:{tokenHash:crypto.createHash('sha256').update(token).digest('hex')}});
      const fresh=await addSession(s,'other');await auth.revokeRefreshToken(token);
      assert.ok((await row(s.other.id)).revokedAt);assert.equal((await row(fresh.id)).revokedAt,null);
    });
    await check('logout using a rotated token still closes its own lineage',async()=>{
      const s=await seed(),token='rotated-token-'+seq;
      const replacement=await addSession(s,'other',s.other.authorizationSessionId);
      await db.refreshSession.update({where:{id:s.other.id},data:{tokenHash:crypto.createHash('sha256').update(token).digest('hex'),revokedAt:new Date()}});
      await auth.revokeRefreshToken(token);assert.ok((await row(replacement.id)).revokedAt);
    });
    await check('refresh reuse revokes only its lineage while a new login survives',async()=>{
      const s=await seed(),token='reused-token-'+seq;const same=await addSession(s,'other',s.other.authorizationSessionId),fresh=await addSession(s,'other');
      await db.refreshSession.update({where:{id:s.other.id},data:{tokenHash:crypto.createHash('sha256').update(token).digest('hex'),revokedAt:new Date()}});
      assert.equal((await auth.refreshAccessToken({refreshToken:token,deviceId:'other',req:{headers:{}}})).code,'REFRESH_REUSED');
      assert.ok((await row(same.id)).revokedAt);assert.equal((await row(fresh.id)).revokedAt,null);
    });
    await check('legacy token has no authority over a modern login',async()=>{
      const s=await seed(),token='legacy-token-'+seq;const legacy=await addSession(s,'other',null,{tokenHash:crypto.createHash('sha256').update(token).digest('hex')});
      await auth.revokeRefreshToken(token);assert.ok((await row(legacy.id)).revokedAt);assert.equal((await row(s.other.id)).revokedAt,null);
    });
    await check('password reset failure rolls back token consumption and all session changes',async()=>{
      const s=await seed(),t=await resetToken(s);
      await db.$executeRawUnsafe('UPDATE "D8PasswordFault" SET enabled=true');
      try { await assert.rejects(resetAccountPassword({db,token:t.token,password:'reset-failure-password'})); }
      finally { await db.$executeRawUnsafe('UPDATE "D8PasswordFault" SET enabled=false'); }
      assert.equal((await db.authToken.findUnique({where:{id:t.row.id}})).usedAt,null);
      assert.equal((await db.user.findUnique({where:{id:s.userId}})).passwordHash,oldHash);assert.equal((await row(s.current.id)).revokedAt,null);
    });
    await check('password prepared outside the transaction cannot overwrite a newer credential',async()=>{
      const s=await seed(),c=await command(s,'account.password'),original=bcrypt.hash;
      bcrypt.hash=async(...args)=>{const value=await original(...args);await db.user.update({where:{id:s.userId},data:{passwordHash:'newer-credential'}});return value;};
      try{await assert.rejects(run(s,c),{code:'SETTINGS_PASSWORD_CHANGED'});}finally{bcrypt.hash=original;}
      assert.equal((await db.user.findUnique({where:{id:s.userId}})).passwordHash,'newer-credential');assert.equal((await row(s.other.id)).revokedAt,null);
    });
    await check('reset issuance refuses stale credential snapshots without email or token',async()=>{
      const s=await seed(),before=await db.user.findUnique({where:{id:s.userId}}),count=emails.length;
      await run(s,await command(s,'account.password'));
      await assert.rejects(auth.issuePasswordReset(before),{code:'PASSWORD_RESET_STALE'});
      assert.equal(await db.authToken.count({where:{userId:s.userId}}),0);assert.equal(emails.length,count);
    });
    await check('concurrent reset issuance retains one current token; mail remains an external effect',async()=>{
      const s=await seed(),before=await db.user.findUnique({where:{id:s.userId}}),count=emails.length;
      await Promise.all([auth.issuePasswordReset(before),auth.issuePasswordReset(before)]);
      assert.equal(await db.authToken.count({where:{userId:s.userId,type:'PASSWORD_RESET',usedAt:null}}),1);assert.equal(emails.length,count+2);
    });
    console.log(JSON.stringify({status:'PASS',cases:cases.length,actualPrisma:true,fullMigrationChain:true,physicalMultiSessionPostgres:false,externalServices:false}));
  } finally { await db.$disconnect(); await server.stop(); await engine.close(); }
}
main().then(()=>{clearInterval(keepAlive);clearTimeout(deadline);},e=>{console.error(e);clearInterval(keepAlive);clearTimeout(deadline);process.exitCode=1;});
