"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),Module=require('node:module');
const original=Module._load;
Module._load=function(name,parent,main){if(name==='../prisma')return {};return original.call(this,name,parent,main);};
const {buildHomeSummary,buildHomeCreatorPage}=require('./home-summary-service');
const planner=require('./analytics-collection-planner');
Module._load=original;
const keys=['money.view_earnings','workspace.view_team','workspace.view_audit','workspace.manage_settings','creator_analytics.refresh'];
const member={id:'m',agencyId:'a',userId:'u',accessEpoch:3,role:'OPERATOR',roleKey:'operator',permissions:Object.fromEntries(keys.map(k=>[k,false])),broad:false,projected:true};
function fake(){let authorityReads=0;let revoked=false;const trace=[];const db={
 $queryRawUnsafe:async(sql,...params)=>{trace.push({sql,params});if(sql.includes('SELECT * FROM authority')){authorityReads++;return revoked&&authorityReads>1?[]:[member];}if(sql==='SELECT clock_timestamp() AS "authorityNow"')return [{authorityNow:new Date('2026-09-29T12:00:00Z')}];if(sql.endsWith('SELECT COUNT(*) AS total FROM visible'))return [{total:16000n}];throw Error('unexpected data read');},
 agency:{findUnique:async()=>({id:'a',name:'Agency',plan:'trial',status:'TRIAL'})},
};return {db,trace,revoke:()=>revoked=true};}
test('A2 actual summary with restricted permissions is scalar; never loads members/devices/creator arrays or revenue',async()=>{
 const f=fake();const r=await buildHomeSummary({db:f.db,agencyId:'a',member});assert.equal(r.contractVersion,2);assert.equal(r.creatorScope.totalCreators,16000);assert.equal(r.creators.length,0);assert.equal(r.revenue.available,false);assert.equal(r.revenue.totalCents,null);assert.equal(r.workers.available,false);assert.equal(r.audit.available,false);assert.equal(r.seats.available,false);assert.ok(Buffer.byteLength(JSON.stringify(r))<2500);assert.equal(f.trace.length,4);
});
test('A2 actual summary drops entire response if epoch is revoked during a read',async()=>{
 const f=fake();f.revoke();await assert.rejects(buildHomeSummary({db:f.db,agencyId:'a',member}),{code:'HOME_ACCESS_CHANGED'});
});
test('A2 actual page validates limit/cursor before any authority or data request',async()=>{
 const f=fake();await assert.rejects(buildHomeCreatorPage({db:f.db,agencyId:'a',member,limit:101}),{code:'HOME_PAGE_SIZE_INVALID'});assert.equal(f.trace.length,0);
});
test('A2 Home compact HTTP auth preserves session checks and never selects assignedCreators',async()=>{
 const source=fs.readFileSync(require.resolve('../middleware/auth'),'utf8');let args;
 const mod={exports:{}};const ctx=vm.createContext({module:mod,exports:mod.exports,require(name){if(name==='./auth-unavailable')return require('../middleware/auth-unavailable');if(name==='../prisma')return {agencyMember:{findFirst:async a=>{args=a;return {...member,user:{emailVerifiedAt:new Date(),disabledAt:null,refreshSessions:[{id:'session',authorizationSessionId:'lineage'}]},agency:{id:'a'}};}}};if(name==='../utils/tokens')return {verifyAccessToken:()=>({userId:'u',agencyId:'a',deviceId:'device',authorizationSessionId:'lineage'})};if(name==='../utils/device-binding')return {};if(name==='../services/db-time-authority-service')return {dbAuthorityNow:async()=>new Date()};throw Error(name);},Date,String,Number,Array,Object});new vm.Script(source).runInContext(ctx);
 let called=false;await mod.exports.homeAuthRequired({headers:{authorization:'Bearer test'}},{status:()=>{throw Error('unexpected rejection');}},()=>called=true);
 assert.equal(called,true);assert.equal(args.select.assignedCreators,undefined);assert.equal(args.select.accessEpoch,true);assert.equal(args.select.user.include.refreshSessions.where.authorizationSessionId,'lineage');assert.equal(args.select.user.include.refreshSessions.where.deviceId,'device');assert.equal(args.select.user.include.refreshSessions.take,1);assert.equal(args.include,undefined);
});
test('A2 compact demand identity separates members and epochs; same intent coalesces without carrying creator ids',async()=>{
 const store=new Map();const db={analyticsCollectionDemand:{findUnique:async({where})=>store.get(where.key)||null,create:async({data})=>{store.set(data.key,data);return data;},update:async({where,data})=>{const row={...store.get(where.key),...data};store.set(where.key,row);return row;}}};
 db.$transaction=async work=>work({...db,$transaction:undefined});db.$executeRawUnsafe=async()=>1;
 const request={db,agencyId:'a',scopeMode:'MEMBER_CURRENT',creatorIds:null,rangeKey:'7d',requestedByMemberId:'m',requestedAccessEpoch:3,now:new Date('2026-09-29T12:00:00Z')};
 const a=await planner.enqueueAgencyAnalyticsFreshnessDemand(request);const b=await planner.enqueueAgencyAnalyticsFreshnessDemand(request);assert.equal(a.key,b.key);assert.equal(b.coalesced,true);
 const c=await planner.enqueueAgencyAnalyticsFreshnessDemand({...request,requestedByMemberId:'other'}),d=await planner.enqueueAgencyAnalyticsFreshnessDemand({...request,requestedAccessEpoch:4});assert.notEqual(c.key,a.key);assert.notEqual(d.key,a.key);for(const row of store.values()){assert.equal(row.creatorIds,null);assert.equal(row.scopeMode,'MEMBER_CURRENT');}
 await assert.rejects(planner.enqueueAgencyAnalyticsFreshnessDemand({...request,creatorIds:['c']}),/SCOPE_INVALID/);
});
