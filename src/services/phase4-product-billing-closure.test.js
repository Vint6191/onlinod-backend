"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {allowsOperationReadback}=require('./billing-operation-readback-service');
const {withProductBilling,inProductBilling,productBillingScope}=require('./product-billing-context-service');
const {isDrainRequest}=require('../middleware/product-billing');
const {billingPage}=require('./admin-billing-read-service');
const {INDEXES,assertIndexDefinition}=require('../../scripts/database/phase4-execution-indexes-online-preflight');

test('readback permits only the durable operation target and bounded registered GET',()=>{
 const row={actionType:'SEND_MESSAGE',dialogId:'123',targetId:'456'};
 const req={method:'GET',path:'/api2/v2/chats/123/messages?limit=50&order=desc&skip_users=all'};
 assert.equal(allowsOperationReadback(row,'chats.messages',req),true);
 for(const change of [{method:'POST'},{path:req.path.replace('/123/','/456/')},{path:req.path+'&limit=50'},{path:req.path+'&anything=1'},{path:req.path.replace('limit=50','limit=101')},{path:req.path+'#fragment'}]) assert.equal(allowsOperationReadback(row,'chats.messages',{...req,...change}),false);
 assert.equal(allowsOperationReadback(row,'chats.list',req),false);
 assert.equal(allowsOperationReadback({actionType:'VAULT_CREATE_LIST'},'vault.lists',{method:'GET',path:'/api2/v2/vault/lists?view=main&limit=200&offset=3800'}),true);
 assert.equal(allowsOperationReadback({actionType:'DELETE_MESSAGE',fanId:'123'},'chats.messages',req),true);
});
test('product context does not leak to another concurrent request or settlement outside its boundary',async()=>{
 assert.equal(inProductBilling(undefined),false);
 const db={$queryRawUnsafe:async()=>[{id:'paid'}]},scope={broad:true,creatorIds:[]};
 await Promise.all(['a','b'].map(agencyId=>withProductBilling(agencyId,async()=>{
   await new Promise(r=>setImmediate(r)); assert.equal(inProductBilling(agencyId),true);assert.equal(inProductBilling(agencyId==='a'?'b':'a'),false);
   assert.deepEqual((await productBillingScope({db,agencyId,scope})).creatorIds,['paid']);
 })));
 assert.strictEqual(await productBillingScope({db,agencyId:'a',scope}),scope);
});
test('receipt exclusions preserve drain without excluding ordinary product routes',()=>{
 for(const [base,path,expected] of [['/api/fan-data','/observations',true],['/api/fan-data','/current',false],['/api/dialog-intelligence','/batches/claim',false],['/api/dialog-intelligence','/batches/one/complete',true],['/api/custom-orders','/telegram-deliveries/one/reference-replace',false],['/api/automation','/worker/complete',true],['/api/automation','/follow/candidates',false],['/api/custom-orders','/order/media-commit',true],['/api/custom-orders','/orders',false]]) assert.equal(isDrainRequest({baseUrl:base,path}),expected);
});
test('billing pages reject unbounded or ambiguous cursors',()=>{
 assert.deepEqual(billingPage(),{limit:100,after:null});assert.deepEqual(billingPage({limit:'2',after:'a'}),{limit:2,after:'a'});
 for(const q of [{limit:101},{limit:0},{limit:1.5},{after:['a','b']},{after:'x'.repeat(181)}]) assert.throws(()=>billingPage(q),{code:'BILLING_PAGE_INVALID'});
});
test('online index validation checks exact table, keys, order, uniqueness and predicate',()=>{
 const spec=INDEXES.find(s=>s[0]==='AutomationDelivery_fair_claim_idx'),state={tableName:spec[1],method:'btree',isUnique:false,keyCount:3,columnCount:3,options:[0,0,3],columns:['"agencyId"','"creatorId"','"claimedAt" DESC'],predicate:'(("originKind" = \'AUTOMATION\'::text) AND ("claimedAt" IS NOT NULL))'};
 assert.doesNotThrow(()=>assertIndexDefinition(state,spec));
 for(const patch of [{tableName:'Other'},{options:[0,0,1]},{isUnique:true},{keyCount:4},{columnCount:4},{predicate:state.predicate.replace('NOT NULL','NULL')},{columns:['"creatorId"','"agencyId"','"claimedAt" DESC']}]) assert.throws(()=>assertIndexDefinition({...state,...patch},spec),/MISMATCH/);
});

test('HTTP memory replay cannot run ahead of current authorization or billing admission',()=>{
 const server=require('node:fs').readFileSync(require('node:path').join(__dirname,'../server.js'),'utf8');
 assert.doesNotMatch(server,/createIdempotencyMiddleware/);
});
