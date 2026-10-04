'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function harness(){
 const routes=new Map(),calls=[];
 const authority={PRODUCT_WRITE_KINDS:{MASS_QUEUE_CREATE:{permissionKey:'chats.mass_message'},MASS_QUEUE_CANCEL:{permissionKey:'chats.mass_message'}},
  prepareProgrammaticWrite:async input=>{calls.push(input);return{ok:true,settlementToken:'capability'};},ProgrammaticOfWriteAuthorityError:class extends Error{}};
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../routes/programmatic-of-writes.js'),'utf8'),{module,exports:module.exports,require:name=>{
  if(name==='express')return{Router:()=>({post:(p,h)=>routes.set(p,h),get(){}})};
  if(name==='zod')return require('zod');
  if(name.endsWith('product-access'))return{
   requireProductDevice(req,id){if(req.auth.deviceId!==id)throw Object.assign(Error('wrong device'),{status:403,code:'DEVICE_MISMATCH'});},
   requireProductCreator:async()=>{},requireProductPermission:async()=>{},currentAccessEpoch:()=>17,
  };
  if(name.endsWith('programmatic-of-write-authority-service'))return authority;
  if(name.endsWith('mass-queue-observation-service'))return{};
  throw Error(name);
 }});
 const invoke=async body=>{const out={status:200};const res={status(n){out.status=n;return this;},json(body){out.body=body;return body;}};
  await routes.get('/:writeId/prepare-mass-write')({body,params:{writeId:'write'},auth:{agencyId:'agency',userId:'user',deviceId:'device',membership:{id:'member'}}},res);return out;};
 return{invoke,calls};
}
const body={protocol:'MASS_RECEIPT_V1',creatorId:'creator',deviceId:'device',kind:'MASS_QUEUE_CREATE',leaseToken:'x'.repeat(32),leaseRevision:1};
test('new MASS commit route binds signed actor/device and accepts only receipt protocol',async()=>{
 const h=harness();assert.equal((await h.invoke(body)).status,200);assert.equal(h.calls.length,1);assert.equal(h.calls[0].agencyId,'agency');assert.equal(h.calls[0].userId,'user');assert.equal(h.calls[0].accessEpoch,17);assert.equal(h.calls[0].writeId,'write');
});
test('missing protocol, foreign product kind, actor override and signed-device mismatch do not mint commit',async()=>{
 for(const patch of [{protocol:undefined},{protocol:'OLD'},{kind:'VAULT_RELAY_SEND'},{agencyId:'foreign'},{deviceId:'other'}]){
  const h=harness(),out=await h.invoke({...body,...patch});assert([400,403].includes(out.status));assert.equal(h.calls.length,0);
 }
});
