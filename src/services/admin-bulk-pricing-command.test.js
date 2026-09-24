"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {randomUUID} = require("node:crypto");
const {createMemoryDb: memoryDb} = require("../../scripts/test-support/admin-command-memory-db");
const fs = require("node:fs"), path = require("node:path");
const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260924003000_phase4_durable_bulk_pricing/migration.sql"), "utf8");
const statusClause = migration.match(/CHECK \(\"status\" IN \(([^)]+)\)\)/)[1];
const commandStatuses = new Set([...statusClause.matchAll(/'([^']+)'/g)].map(match=>match[1]));
const createMemoryDb = options => memoryDb({ ...options, commandStatuses });
const {submitAdminBulkPricing,processAdminBulkPricingItem,GENERATION} = require("./admin-bulk-pricing-command-service");
const {readAdminCommand} = require("./admin-commit-authority-service");
const {DEFAULT_SETTINGS} = require("./billing-commercial-policy-service");
const actor = {adminId:"admin-a",sessionId:"session-a",accessEpoch:1};
function input(extra={}) {return {tier:"PRO",reason:"Correct agreed pricing",items:[{creatorId:"creator-a",expectedRevision:1}],...extra};}
function submit(m,payload=input(),id=randomUUID()){return submitAdminBulkPricing({db:m.db,actor,commandId:id,agencyId:"agency-a",payload});}
function add(m,id="creator-b") {m.state.creators.push({id,agencyId:"agency-a",deletedAt:null});m.state.profiles.push({...m.state.profiles[0],id:`profile-${id}`,creatorId:id});}
function claim(m,index=0) {const row=m.state.workItems[index];Object.assign(row,{state:"CLAIMED",ownerToken:randomUUID(),claimedRevision:row.requestedRevision,claimFence:row.claimFence+1n,leaseUntil:new Date(m.clock.getTime()+120000)});return {item:structuredClone(row),ownerToken:row.ownerToken};}
function run(m,c=claim(m)){return processAdminBulkPricingItem({db:m.db,...c});}

test("atomic admission returns 202 and retry never republishes or changes pricing",async()=>{const m=createMemoryDb();const id=randomUUID();const a=await submit(m,input(),id);assert.equal(a.statusCode,202);assert.equal(m.state.commands[0].status,"QUEUED");assert.equal(m.state.profiles[0].tier,"STARTER");const b=await submit(m,input(),id);assert.deepEqual(b.body,a.body);assert.equal(m.state.workItems.length,1);assert.equal(m.state.audit.length,1);await assert.rejects(submit(m,input({tier:"ELITE"}),id),{code:"ADMIN_COMMAND_PAYLOAD_CONFLICT"});});
test("publication or acceptance-audit failure rolls back the entire admission",async()=>{for(const failure of ["failPublish","failAudit"]){const m=createMemoryDb({[failure]:true});await assert.rejects(submit(m));assert.equal(m.state.commands.length,0);assert.equal(m.state.workItems.length,0);assert.equal(m.state.audit.length,0);}});
test("selection requires 1–100 unique IDs, revisions, reason and explicit CUSTOM price",async()=>{const m=createMemoryDb();for(const payload of [{tier:"PRO"},input({items:[]}),input({items:Array.from({length:101},(_,i)=>({creatorId:`c${i}`,expectedRevision:1}))}),input({items:[...input().items,...input().items]}),input({tier:"CUSTOM"}),input({reason:" "})])await assert.rejects(submit(m,payload));assert.equal(m.state.workItems.length,0);});
test("foreign or retired selected creator rejects admission before publishing",async()=>{const m=createMemoryDb();m.state.creators[0].agencyId="other";const r=await submit(m);assert.equal(r.body.code,"ADMIN_SELECTION_SCOPE_INVALID");assert.equal(m.state.workItems.length,0);});
test("bulk uses canonical single-item pricing, completes and preserves paid entitlement",async()=>{const m=createMemoryDb();m.state.entitlements.push({creatorId:"creator-a",coreSource:"PAYMENT",coreValidUntil:new Date("2027-01-01")});const before=structuredClone(m.state.entitlements);const accepted=await submit(m);const r=await run(m);assert.equal(r.status,"SUCCEEDED");assert.equal(m.state.profiles[0].corePriceCents,DEFAULT_SETTINGS.proPriceCents);assert.equal(m.state.profiles[0].tierMode,"MANUAL");assert.deepEqual(m.state.entitlements,before);assert.equal(m.state.workItems[0].state,"DONE");assert.equal(m.state.audit.length,2);const status=await readAdminCommand({db:m.db,actor,commandId:accepted.commandId});assert.equal(status.execution.progress.succeeded,1);assert.equal(status.execution.workState,"DONE");});
test("durable cursor resumes exactly once after restart and records stale target rejection",async()=>{const m=createMemoryDb();add(m);await submit(m,input({items:[...input().items,{creatorId:"creator-b",expectedRevision:1}]}));await run(m);assert.equal(m.state.commands[0].executionProgress.nextIndex,1);m.state.profiles[1].pricingRevision=2;m.state.profiles[1].corePriceCents=7777;const r=await run(m);assert.equal(r.status,"COMPLETED_WITH_REJECTIONS");assert.equal(m.state.commands[0].executionProgress.rejected,1);assert.equal(m.state.profiles[1].corePriceCents,7777);assert.equal(m.state.profiles[0].pricingRevision,2);});
test("audit failure rolls back price and cursor; same claim retry applies once",async()=>{const m=createMemoryDb();await submit(m);const c=claim(m);m.options.failAudit=true;await assert.rejects(run(m,c));assert.equal(m.state.profiles[0].tier,"STARTER");assert.equal(m.state.commands[0].executionProgress.nextIndex,0);m.options.failAudit=false;await run(m,c);assert.equal(m.state.profiles[0].pricingRevision,2);assert.equal(m.state.audit.length,2);});
test("expired or replaced lease rejects work without advancing or mutating",async()=>{for(const mutation of [m=>m.state.workItems[0].leaseUntil=new Date(m.clock.getTime()-1),m=>m.state.workItems[0].claimFence++]){const m=createMemoryDb();await submit(m);const c=claim(m);mutation(m);await assert.rejects(run(m,c),{code:"ADMIN_WORK_CLAIM_LOST"});assert.equal(m.state.profiles[0].tier,"STARTER");assert.equal(m.state.commands[0].executionProgress.nextIndex,0);}});
test("claim loss at final settlement rolls back price, progress and item audit",async()=>{const m=createMemoryDb();await submit(m);const c=claim(m);m.options.loseSettlement=true;await assert.rejects(run(m,c),{code:"ADMIN_WORK_CLAIM_LOST"});assert.equal(m.state.profiles[0].tier,"STARTER");assert.equal(m.state.commands[0].executionProgress.nextIndex,0);assert.equal(m.state.audit.length,1);});
test("revocation between targets pauses remaining effects and preserves progress",async()=>{const m=createMemoryDb();add(m);await submit(m,input({items:[...input().items,{creatorId:"creator-b",expectedRevision:1}]}));await run(m);m.state.sessions[0].revokedAt=m.clock;const r=await run(m);assert.equal(r.status,"PAUSED_AUTH");assert.equal(m.state.commands[0].executionProgress.nextIndex,1);assert.equal(m.state.profiles[1].tier,"STARTER");assert.equal(m.state.workItems[0].state,"DONE");});
test("resume is a new authorized intent linked to exactly the original remaining manifest",async()=>{const m=createMemoryDb();add(m);const old=await submit(m,input({items:[...input().items,{creatorId:"creator-b",expectedRevision:1}]}));await run(m);m.state.sessions[0].revokedAt=m.clock;await run(m);m.state.sessions[0].revokedAt=null;const payload=input({resumesCommandId:old.commandId,items:[{creatorId:"creator-b",expectedRevision:1}]});const bad=await submit(m,{...payload,tier:"ELITE"});assert.equal(bad.body.code,"ADMIN_RESUME_INTENT_CHANGED");const accepted=await submit(m,payload);assert.equal(accepted.statusCode,202);assert.equal(m.state.commands[0].status,"RESUMED");const duplicate=await submit(m,payload);assert.equal(duplicate.body.code,"ADMIN_RESUME_NOT_AVAILABLE");await run(m,claim(m,1));assert.equal(m.state.profiles[1].tier,"PRO");assert.equal(m.state.profiles[0].pricingRevision,2);});
test("retired agency stops pending command; no further price writes",async()=>{const m=createMemoryDb();await submit(m);m.state.agencies[0].deletedAt=m.clock;const r=await run(m);assert.equal(r.status,"STOPPED_TARGET");assert.equal(m.state.profiles[0].tier,"STARTER");});
test("excluded models skip; dirty historical scope and retired creators reject per item",async()=>{for(const [change,status,code] of [[m=>m.state.profiles[0].billingExcluded=true,"SKIPPED","BILLING_EXCLUDED"],[m=>m.state.profiles[0].agencyId="other","REJECTED","BILLING_SCOPE_MISMATCH"],[m=>m.state.creators[0].deletedAt=m.clock,"REJECTED","CREATOR_NOT_FOUND"]]){const m=createMemoryDb();await submit(m);change(m);await run(m);const result=m.state.commands[0].executionProgress.outcomes[0];assert.equal(result.status,status);assert.equal(result.code,code);assert.equal(m.state.profiles[0].tier,"STARTER");}});
test("a terminal command cannot replay an item even when queue work is reintroduced",async()=>{const m=createMemoryDb();await submit(m);await run(m);const revision=m.state.profiles[0].pricingRevision;await run(m);assert.equal(m.state.profiles[0].pricingRevision,revision);assert.equal(m.state.audit.length,2);});

test("a fair pump uses bounded claims and persists ten independent item commits before yielding",async t=>{
 const m=createMemoryDb();for(let i=1;i<12;i++)add(m,`creator-${i}`);
 await submit(m,input({items:m.state.creators.map(c=>({creatorId:c.id,expectedRevision:1}))}));
 const c=claim(m);
 const authority=require("./domain-work-authority-service");
 t.mock.method(authority,"claimDomainWorkBatch",async options=>{assert.equal(options.limit,4);assert.equal(options.perAgencyQuantum,1);assert.equal(options.generation,GENERATION);return {items:[c.item],ownerToken:c.ownerToken};});
 const {runAdminBulkPricingSweep}=require("./admin-bulk-pricing-command-service");
 const first=await runAdminBulkPricingSweep({db:m.db});assert.equal(first.processed,10);assert.equal(first.ok,true);assert.equal(m.state.commands[0].executionProgress.nextIndex,10);assert.equal(m.state.workItems[0].state,"READY");
 const next=claim(m);t.mock.method(authority,"claimDomainWorkBatch",async()=>({items:[next.item],ownerToken:next.ownerToken}));
 const second=await runAdminBulkPricingSweep({db:m.db});assert.equal(second.processed,2);assert.equal(m.state.commands[0].status,"SUCCEEDED");assert.ok(m.state.profiles.every(p=>p.pricingRevision===2));
});
test("infrastructure poison is visible through existing finite retry/reconcile protocol",async t=>{
 const m=createMemoryDb();const accepted=await submit(m);
 const authority=require("./domain-work-authority-service");
 const {runAdminBulkPricingSweep}=require("./admin-bulk-pricing-command-service");
 for(let i=0;i<8;i++){
  const c=claim(m);t.mock.method(authority,"claimDomainWorkBatch",async()=>({items:[c.item],ownerToken:c.ownerToken}));m.options.failAudit=true;
  const report=await runAdminBulkPricingSweep({db:m.db});assert.equal(report.ok,false);
 }
 m.options.failAudit=false;
 const status=await readAdminCommand({db:m.db,actor,commandId:accepted.commandId});
 assert.equal(status.execution.workState,"RECONCILE_REQUIRED");assert.equal(status.execution.errorClass,"RETRY_EXHAUSTED");assert.equal(status.execution.progress.nextIndex,0);assert.equal(m.state.profiles[0].tier,"STARTER");
});
test("cancellation serializes with worker intent and preserves already committed targets",async()=>{
 const m=createMemoryDb();add(m);const accepted=await submit(m,input({items:[...input().items,{creatorId:"creator-b",expectedRevision:1}]}));await run(m);
 const {cancelAdminBulkPricing}=require("./admin-bulk-pricing-command-service");
 const args={db:m.db,actor,commandId:randomUUID(),agencyId:"agency-a",payload:{targetCommandId:accepted.commandId,reason:"Operator cancelled remaining targets"}};
 const cancelled=await cancelAdminBulkPricing(args);assert.equal(cancelled.body.status,"CANCELLED");await run(m);assert.equal(m.state.profiles[0].tier,"PRO");assert.equal(m.state.profiles[1].tier,"STARTER");assert.equal(m.state.commands[0].executionProgress.nextIndex,1);
 assert.equal((await cancelAdminBulkPricing(args)).replayed,true);
});
test("cancellation audit failure leaves the original job resumable without a fake receipt",async()=>{
 const m=createMemoryDb();const accepted=await submit(m);m.options.failAudit=true;
 const {cancelAdminBulkPricing}=require("./admin-bulk-pricing-command-service");
 await assert.rejects(cancelAdminBulkPricing({db:m.db,actor,commandId:randomUUID(),agencyId:"agency-a",payload:{targetCommandId:accepted.commandId,reason:"Cancel"}}));
 assert.equal(m.state.commands.length,1);assert.equal(m.state.commands[0].status,"QUEUED");
});
