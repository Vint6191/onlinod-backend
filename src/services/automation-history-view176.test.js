'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function fixture() {
  const rows = ['QUEUED','COMPLETED','FAILED','RUNNING','SKIPPED','CANCELED','RETRY_SCHEDULED','PAUSED','COMMITTING','RECONCILE_REQUIRED']
    .map((status, index) => ({id:String(index),status,agencyId:'agency',creatorId:'a',originKind:'AUTOMATION',finishedAt:index,updatedAt:index}));
  rows.push({...rows[1],id:'other-agency',agencyId:'other'}, {...rows[1],id:'not-accessible',creatorId:'b'}, {...rows[1],id:'custom',originKind:'CUSTOM'});
  const calls=[];
  const select = where => rows.filter(row => row.agencyId===where.agencyId && row.originKind===where.originKind
    && (!where.creatorId || (typeof where.creatorId==='string' ? row.creatorId===where.creatorId : where.creatorId.in.includes(row.creatorId)))
    && (!where.status || (typeof where.status==='string' ? row.status===where.status : where.status.in.includes(row.status))));
  const prisma={automationDelivery:{
    async findMany(input){calls.push(input);const data=select(input.where);if(input.orderBy[0].finishedAt)data.sort((a,b)=>b.finishedAt-a.finishedAt);return data.slice(input.skip,input.skip+input.take);},
    async count({where}){return select(where).length;},
  }};
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('./automation-action-delivery-service'),'utf8'),{
    module,exports:module.exports,console,require:name=>name==='../prisma'?prisma:name==='node:crypto'?require(name):{},
  });
  return {read:input=>module.exports.listActionDeliveries({agencyId:'agency',creatorIds:['a'],...input}),calls};
}

test('history applies terminal statuses and authorized scope before paging/counting',async()=>{
  const {read,calls}=fixture();
  const first=await read({view:'history',limit:2});
  assert.deepEqual(first.items.map(row=>row.status),['CANCELED','SKIPPED']);
  assert.equal(first.count,4);assert.equal(first.hasMore,true);assert.equal(first.nextOffset,2);
  const second=await read({view:'history',offset:first.nextOffset,limit:2});
  assert.deepEqual(second.items.map(row=>row.status),['FAILED','COMPLETED']);assert.equal(second.hasMore,false);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].orderBy)),[{finishedAt:{sort:'desc',nulls:'last'}},{updatedAt:'desc'},{id:'desc'}]);
});
test('queue retains paused/retry/reconciliation work and excludes terminal history',async()=>{
  const {read}=fixture();const result=await read({view:'queue'});
  assert.deepEqual(result.items.map(row=>row.status),['QUEUED','RUNNING','RETRY_SCHEDULED','PAUSED','COMMITTING','RECONCILE_REQUIRED']);
  assert.equal(result.count,6);
});
test('specific status narrows selected view and contradictory requests fail before reads',async()=>{
  const {read,calls}=fixture();const failed=await read({view:'history',status:'FAILED'});
  assert.equal(failed.count,1);assert.equal(failed.items[0].status,'FAILED');
  for(const input of [{view:'history',status:'QUEUED'},{view:'queue',status:['RUNNING','COMPLETED']}])
    await assert.rejects(read(input),error=>error.code==='DELIVERY_STATUS_VIEW_MISMATCH'&&error.status===400);
  await assert.rejects(read({view:'unknown'}),error=>error.code==='DELIVERY_VIEW_INVALID'&&error.status===400);
  assert.equal(calls.length,1);
});
test('existing callers without a view retain explicit status and empty-scope isolation',async()=>{
  const {read}=fixture();assert.equal((await read({status:'FAILED'})).count,1);
  assert.equal((await read({view:'history',creatorIds:[]})).count,0);
});
