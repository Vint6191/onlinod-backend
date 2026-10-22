'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { replaceUsageSources } = require('./media-library-service');
const db=new Proxy({}, {get(){throw Error('MUST_REJECT_BEFORE_DATABASE_ACCESS');}});
test('oversized usage source is rejected before any source state or contribution can change',async()=>{
  await assert.rejects(replaceUsageSources({agencyId:'a',creatorId:'c',db,sources:[{protocolVersion:2,sourceKey:'source',sourceRevision:'2026-10-11',capturedAt:'2026-10-11T00:00:00Z',coverage:{version:1,complete:true,localRevision:'r',messageCount:0,oldestMessageAt:null,newestMessageAt:null},facts:Array.from({length:2001},(_,i)=>({mediaId:String(i),sentCount:1}))}]}),e=>e.code==='MEDIA_LIBRARY_USAGE_SOURCE_TOO_LARGE'&&e.status===413);
});
test('oversized source batch cannot silently acknowledge only its first 25 entries',async()=>{
  await assert.rejects(replaceUsageSources({agencyId:'a',creatorId:'c',db,sources:Array.from({length:26},(_,i)=>({sourceKey:String(i),sourceRevision:'2026-10-11',items:[]}))}),e=>e.code==='MEDIA_LIBRARY_USAGE_BATCH_TOO_LARGE'&&e.status===413);
});
