"use strict";
// Disposable full-migration SQL proof. Does not use the caller's DATABASE_URL.
const assert=require('node:assert/strict'),path=require('node:path'),crypto=require('node:crypto');
const {createRequire}=require('node:module'),{spawn}=require('node:child_process');
const {PrismaClient}=require('@prisma/client');
const keepAlive=setInterval(()=>{},1000);
const deadline=setTimeout(()=>{console.error('LOCAL_PROOF_DEADLINE');process.exit(2);},55000);
async function main(){
  if(!process.env.PHASE5_PROOF_RUNTIME)throw Error('PHASE5_PROOF_RUNTIME required');
  const load=createRequire(path.resolve(process.env.PHASE5_PROOF_RUNTIME,'package.json'));
  const {PGlite}=load('@electric-sql/pglite'),{PGLiteSocketServer}=load('@electric-sql/pglite-socket');
  console.log('PROOF_ENGINE_START');const engine=await PGlite.create();
  const server=new PGLiteSocketServer({db:engine,host:'127.0.0.1',port:0});await server.start();
  const url=`postgresql://postgres:postgres@${server.getServerConn()}/postgres?connection_limit=1&sslmode=disable`;
  const db=new PrismaClient({datasources:{db:{url}}}),cases=[];
  const check=async(name,work)=>{await work();cases.push({name,status:'PASS'});console.log(JSON.stringify(cases.at(-1)));};
  try{
    await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[require.resolve('prisma/build/index.js'),'migrate','deploy'],{cwd:path.resolve(__dirname,'../..'),env:{...process.env,DATABASE_URL:url},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('close',code=>code?reject(Error(output)):resolve());});
    console.log('PROOF_MIGRATIONS_APPLIED');await engine.exec('DISCARD ALL');console.log('PROOF_WIRE_RESET');await engine.exec("SET TIME ZONE 'UTC'");
    await engine.exec(`UPDATE "Phase2ReleaseCompatibilityAuthority" SET "activationState"='ACTIVE' WHERE "scope"='TEAM_CONTROL_PLANE'`);
    console.log('PROOF_FIXTURE_DDL_READY');
    require.cache[require.resolve('../../src/prisma')]={exports:db};
    const custom=require('../../src/services/custom-orders-service'),network=require('../../src/services/creator-network-profile-service'),settings=require('../../src/services/settings-service'),bcrypt=require('bcryptjs');
    const oldHash=await bcrypt.hash('original-password',4);
    const generation=tx=>tx.$executeRawUnsafe("SELECT set_config('onlinod.phase2_team_control_plane_generation',$1,true)",'phase2_team_control_plane_v2_durable_access');
    let seq=0;
    async function seed(){return db.$transaction(async tx=>{
      await generation(tx);const tag='d5-'+ ++seq;
      const user=await tx.user.create({data:{email:tag+'@example.test',passwordHash:oldHash,name:'before'}});
      const agency=await tx.agency.create({data:{name:tag,trialEndsAt:new Date('2099-01-01')}});
      const member=await tx.agencyMember.create({data:{agencyId:agency.id,userId:user.id,role:'OWNER',roleKey:'owner',assignedCreators:'all',permissions:{}}});
      const creator=await tx.creatorAccount.create({data:{agencyId:agency.id,displayName:tag,status:'READY'}});
      return {agencyId:agency.id,userId:user.id,member,creatorId:creator.id};
    });}
    const orderInput=s=>({clientMutationId:crypto.randomUUID(),creatorId:s.creatorId,dialogId:'42',scenario:'SQL recovery proof',type:'CONTENT',contentKind:'BOTH',priceCents:15000});
    const proxyInput={label:'Dedicated',type:'SOCKS5',host:'proxy.example.test',port:1080};
    const createProxy=s=>network.createProxyForCreator({db,agencyId:s.agencyId,creatorId:s.creatorId,actorUserId:s.userId,actorMember:s.member,deviceId:'unused-for-no-credentials',expectedNetworkVersion:0,input:proxyInput});
    const updateProxy=(s,p)=>network.updateProxyEndpoint({db,agencyId:s.agencyId,actorUserId:s.userId,actorMember:s.member,proxyId:p.proxy.id,expectedVersion:p.proxy.version,patch:{label:'Edited'}});
    async function disable(s){await db.$transaction(async tx=>{
      await generation(tx);await tx.agencyMember.update({where:{id:s.member.id},data:{role:'ADMIN',roleKey:'admin'}});
      const replacement=await tx.user.create({data:{email:'replacement-'+s.userId+'@example.test',passwordHash:oldHash}});
      await tx.agencyMember.create({data:{agencyId:s.agencyId,userId:replacement.id,role:'OWNER',roleKey:'owner',assignedCreators:'all'}});
      await tx.user.update({where:{id:s.userId},data:{disabledAt:new Date()}});
    });assert.ok((await db.user.findUnique({where:{id:s.userId}})).disabledAt);}
    await check('Custom create replay persists one order, one immutable intent binding',async()=>{
      const s=await seed(),input=orderInput(s),args={...s,input,db};const first=await custom.createCustomOrder(args),again=await custom.createCustomOrder(args);
      assert.equal(first.order.id,again.order.id);assert.equal(again.idempotent,true);assert.equal(await db.customOrder.count({where:{agencyId:s.agencyId}}),1);
      const read=await custom.getCustomOrderByClientMutationId({...s,clientMutationId:input.clientMutationId,db});assert.equal(read.order.id,first.order.id);
      await assert.rejects(custom.createCustomOrder({...args,input:{...input,scenario:'different'}}),e=>e.code==='CUSTOM_ORDER_CLIENT_MUTATION_CONFLICT');
    });
    await check('Two admitted Custom requests resolve to the same order on actual SQL',async()=>{
      const s=await seed(),input=orderInput(s);const results=await Promise.all([custom.createCustomOrder({...s,input,db}),custom.createCustomOrder({...s,input,db})]);assert.equal(results[0].order.id,results[1].order.id);assert.equal(results.filter(x=>x.idempotent).length,1);assert.equal(await db.customOrder.count({where:{agencyId:s.agencyId}}),1);
    });
    await check('Custom committed replay and readback reject disabled actor',async()=>{
      const s=await seed(),input=orderInput(s);await custom.createCustomOrder({...s,input,db});await disable(s);
      await assert.rejects(custom.createCustomOrder({...s,input,db}),e=>e.code==='CUSTOM_MANAGEMENT_ACCESS_REVOKED');await assert.rejects(custom.getCustomOrderByClientMutationId({...s,clientMutationId:input.clientMutationId,db}),e=>e.code==='CUSTOM_MANAGEMENT_ACCESS_REVOKED');assert.equal(await db.customOrder.count({where:{agencyId:s.agencyId}}),1);
    });
    await check('Custom replay rejects admitted epoch after role mutation',async()=>{
      const s=await seed(),input=orderInput(s);await custom.createCustomOrder({...s,input,db});await db.$transaction(async tx=>{await generation(tx);await tx.agencyMember.update({where:{id:s.member.id},data:{permissions:{'custom.manage':true}}});});
      assert.notEqual((await db.agencyMember.findUnique({where:{id:s.member.id}})).accessEpoch,s.member.accessEpoch);
      await assert.rejects(custom.createCustomOrder({...s,input,db}),e=>e.code==='CUSTOM_MANAGEMENT_ACCESS_STALE');
    });
    await check('Unowned pool creation is retired and leaves no row',async()=>{const s=await seed();await assert.rejects(network.createProxyEndpoint({db,agencyId:s.agencyId,actorUserId:s.userId,actorMember:s.member,input:proxyInput}),e=>e.code==='PROXY_POOL_CREATE_RETIRED'&&e.status===410);assert.equal(await db.agencyProxyEndpoint.count({where:{agencyId:s.agencyId}}),0);});
    await check('Dedicated proxy create/edit preserves CAS and profile atomicity',async()=>{const s=await seed(),p=await createProxy(s);assert.equal(p.profile.proxyEndpointId,p.proxy.id);const edited=await updateProxy(s,p);assert.equal(edited.proxy.version,2);await assert.rejects(updateProxy(s,p),e=>e.code==='PROXY_VERSION_CONFLICT');assert.equal(await db.agencyProxyEndpoint.count({where:{agencyId:s.agencyId}}),1);});
    await check('Lost create response retried with original CAS does not create another proxy',async()=>{const s=await seed();await createProxy(s);await assert.rejects(createProxy(s),e=>e.code==='CREATOR_NETWORK_VERSION_CONFLICT');assert.equal(await db.agencyProxyEndpoint.count({where:{agencyId:s.agencyId}}),1);});
    await check('Proxy metadata edit rejects disabled User and preserves version',async()=>{const s=await seed(),p=await createProxy(s);await disable(s);await assert.rejects(updateProxy(s,p),e=>e.code==='PROXY_MEMBER_INACTIVE');const row=await db.agencyProxyEndpoint.findUnique({where:{id:p.proxy.id}});assert.equal(row.label,'Dedicated');assert.equal(row.version,1);});
    await check('Proxy edit rejects admitted access epoch after permission change',async()=>{const s=await seed(),p=await createProxy(s);await db.$transaction(async tx=>{await generation(tx);await tx.agencyMember.update({where:{id:s.member.id},data:{permissions:{'creators.manage':true}}});});await assert.rejects(updateProxy(s,p),e=>e.code==='PROXY_ACCESS_STALE');assert.equal((await db.agencyProxyEndpoint.findUnique({where:{id:p.proxy.id}})).version,1);});
    await check('Already-deleted proxy response still rejects disabled actor',async()=>{const s=await seed();await disable(s);await assert.rejects(network.deleteProxyEndpoint({db,agencyId:s.agencyId,actorUserId:s.userId,actorMember:s.member,proxyId:'missing',expectedVersion:1}),e=>e.code==='PROXY_MEMBER_INACTIVE');});
    await check('Account profile/avatar commit rejects disabled User',async()=>{const s=await seed();await disable(s);await assert.rejects(settings.updateAccountProfile({...s,name:'after',db}),e=>e.code==='SETTINGS_ACCOUNT_INACTIVE');await assert.rejects(settings.updateAccountAvatar({...s,avatarUrl:'https://example.test/a',db}),e=>e.code==='SETTINGS_ACCOUNT_INACTIVE');assert.equal((await db.user.findUnique({where:{id:s.userId}})).name,'before');});
    await check('Account profile/avatar valid writes commit through SQL account owner',async()=>{const s=await seed();await settings.updateAccountProfile({...s,name:'after',db});await settings.updateAccountAvatar({...s,avatarUrl:'https://example.test/a',db});const row=await db.user.findUnique({where:{id:s.userId}});assert.equal(row.name,'after');assert.equal(row.avatarUrl,'https://example.test/a');});
    await check('Concurrent password changes: formerly valid password cannot overwrite winner',async()=>{
      const s=await seed(),args={...s,currentPassword:'original-password',db};const results=await Promise.allSettled([settings.changeAccountPassword({...args,newPassword:'next-password-one'}),settings.changeAccountPassword({...args,newPassword:'next-password-two'})]);
      assert.equal(results.filter(x=>x.status==='fulfilled').length,1);const rejected=results.find(x=>x.status==='rejected');assert.ok(['SETTINGS_PASSWORD_CHANGED','SETTINGS_CURRENT_PASSWORD_INVALID'].includes(rejected.reason.code));
      const winner=results[0].status==='fulfilled'?'next-password-one':'next-password-two',row=await db.user.findUnique({where:{id:s.userId}});assert.ok(await bcrypt.compare(winner,row.passwordHash));
    });
    await check('Password change rejects disabled User without replacing persisted hash',async()=>{const s=await seed();await disable(s);await assert.rejects(settings.changeAccountPassword({...s,currentPassword:'original-password',newPassword:'blocked-password',db}),e=>e.code==='SETTINGS_ACCOUNT_INACTIVE');assert.equal((await db.user.findUnique({where:{id:s.userId}})).passwordHash,oldHash);});
    console.log(JSON.stringify({status:'PASS',cases:cases.length,actualPrisma:true,fullMigrationChain:true,physicalMultiSessionPostgres:false,externalServices:false}));
  }finally{await db.$disconnect();await server.stop();await engine.close();}
}
main().then(()=>{clearInterval(keepAlive);clearTimeout(deadline);},e=>{console.error(e);clearInterval(keepAlive);clearTimeout(deadline);process.exitCode=1;});
