'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const original = Module._load;
Module._load = function(request, parent, ...args) {
  if (request === '../prisma') return {};
  if (request === './automation-write-commit-fence-service' && parent.filename.endsWith('/bump-service.js')) return { runWithAutomationWriteCommitFence: ({db,work}) => work(db) };
  return original.call(this,request,parent,...args);
};
const service = require('./bump-service');
Module._load = original;
function fixture() {
  const sentAt = new Date('2026-10-23T12:00:00Z');
  const state = { id:'state', agencyId:'a',creatorId:'c',fanId:'f',pendingMessageId:'100',pendingDeliveryId:'send',lastSentAt:sentAt,lastBumpSentAt:sentAt,counters:{} };
  let stats = 0, changes = 0;
  const send = { id:'send',agencyId:'a',creatorId:'c',fanId:'f',sentAt,payload:{timing:{}},result:{} };
  const db = { automationBumpFanState:{findUnique:async()=>({...state}),updateMany:async({where,data})=>{
    if(state.pendingMessageId!==where.pendingMessageId)return {count:0};Object.assign(state,data);changes++;return {count:1};
  }},automationDelivery:{findFirst:async()=>null,findUnique:async()=>send,update:async()=>{}},bumpDeliveryStat:{upsert:async()=>{stats++;}}};
  return {db,state,send,sentAt,stats:()=>stats,changes:()=>changes};
}
test('reply before current Bump episode cannot clear it or increment its statistics',async()=>{
  const f=fixture();const result=await service.processRuntimeEvents({agencyId:'a',creatorId:'c',db:f.db,events:[{type:'chat_message_received',fanId:'f',messageId:'90',createdAt:'2026-10-23T11:59:30Z'}]});
  assert.equal(result.replies,0);assert.deepEqual(result.errors,[]);assert.equal(f.state.pendingMessageId,'100');assert.equal(f.changes(),0);assert.equal(f.stats(),0);
});
test('valid current-episode reply is applied once and replay cannot close another episode',async()=>{
  const f=fixture(),event={type:'chat_message_received',fanId:'f',messageId:'101',createdAt:'2026-10-23T12:00:01Z'};
  assert.equal((await service.processRuntimeEvents({agencyId:'a',creatorId:'c',db:f.db,events:[event]})).replies,1);assert.equal(f.stats(),1);
  Object.assign(f.state,{pendingMessageId:'200',pendingDeliveryId:'send2',lastBumpSentAt:new Date('2026-10-23T12:00:20Z')});
  assert.equal((await service.processRuntimeEvents({agencyId:'a',creatorId:'c',db:f.db,events:[event]})).replies,0);assert.equal(f.state.pendingMessageId,'200');assert.equal(f.stats(),1);
});
test('missing event timestamp and delayed edit time cannot manufacture reply evidence',async()=>{
  const f=fixture();for(const event of [{type:'chat_message_received',fanId:'f',messageId:'101'},{type:'chat_message_received',fanId:'f',messageId:'101',changedAt:'2026-10-23T12:10:00Z'}]) {
    assert.equal((await service.processRuntimeEvents({agencyId:'a',creatorId:'c',db:f.db,events:[event]})).replies,0);
  }assert.equal(f.changes(),0);
});
test('historical presence cannot schedule or refresh live online Bumps',async()=>{
  const result=await service.processRuntimeEvents({agencyId:'a',creatorId:'c',db:{},reconcileOnly:true,events:[{type:'presence_online',fanIds:['f'],createdAt:'2026-01-01T00:00:00Z'}]});
  assert.equal(result.planned,0);assert.equal(result.onlineObserved,0);assert.deepEqual(result.errors,[]);
});

test('missing legacy send and reply clocks cannot become an epoch-zero episode proof',async()=>{
  const f=fixture();delete f.state.lastSentAt;delete f.state.lastBumpSentAt;delete f.send.sentAt;
  assert.equal((await service.markBumpReply({agencyId:'a',creatorId:'c',fanId:'f',messageId:'101',db:f.db})).code,'reply_episode_time_unproven');
  assert.equal((await service.markBumpReply({agencyId:'a',creatorId:'c',fanId:'f',messageId:'101',repliedAt:'2026-10-23T12:00:01Z',db:f.db})).code,'reply_episode_time_unproven');
  assert.equal(f.changes(),0);assert.equal(f.stats(),0);
});
