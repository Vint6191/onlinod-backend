"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const window={};vm.runInNewContext(fs.readFileSync(require.resolve('../../public/admin/modules/admin-billing/admin-entitlements.js'),'utf8'),{window});
const {command,value}=window.OnlinodAdminEntitlements;
test('AI-only edit retains untouched paid timestamps and does not change core tier',()=>{
 const model={tier:'ELITE',entitlement:{entitlementRevision:7,tier:'PRO',coreValidUntil:'2026-12-01T12:34:56.987Z',aiChatterValidUntil:null,outreachValidUntil:null}};
 const body=command(model,{tier:'PRO',coreValidUntil:value(model.entitlement.coreValidUntil),aiChatterValidUntil:'2026-12-03T00:00:00',outreachValidUntil:'',reason:'AI extension'});
 assert.equal(body.expectedRevision,7);assert.equal(Object.hasOwn(body,'coreValidUntil'),false);assert.equal(Object.hasOwn(body,'tier'),false);assert.equal(body.aiChatterValidUntil,'2026-12-03T00:00:00.000Z');
});
test('addon-only grant with no prior entitlement does not fabricate core revoke',()=>{
 const body=command({tier:'ELITE',entitlement:null},{tier:'ELITE',coreValidUntil:'',aiChatterValidUntil:'2026-12-03T00:00:00',outreachValidUntil:'',reason:'AI grant'});
 assert.equal(body.expectedRevision,0);assert.equal(Object.hasOwn(body,'coreValidUntil'),false);assert.equal(Object.hasOwn(body,'tier'),false);
});
test('tier change preserves the exact core deadline, while explicit clearing revokes only that component',()=>{
 const model={entitlement:{tier:'PRO',entitlementRevision:1,coreValidUntil:'2026-12-01T12:34:56.987Z'}};
 const draft={tier:'ELITE',coreValidUntil:value(model.entitlement.coreValidUntil),aiChatterValidUntil:'',outreachValidUntil:'',reason:'Tier correction'};
 assert.equal(command(model,draft).coreValidUntil,model.entitlement.coreValidUntil);
 const revoke=command(model,{...draft,tier:'PRO',coreValidUntil:''});assert.equal(revoke.coreValidUntil,null);assert.equal(Object.hasOwn(revoke,'aiChatterValidUntil'),false);
 assert.throws(()=>command(model,{...draft,reason:''}),/reason/);
});
