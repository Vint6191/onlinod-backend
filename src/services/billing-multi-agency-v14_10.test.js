"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const fs = require("node:fs");

const nowPath = path.join(__dirname, "billing-nowpayments-service.js");
const walletPath = path.join(__dirname, "billing-wallet-service.js");

function withEnv(values, fn) {
  const old = {};
  for (const [k,v] of Object.entries(values)) { old[k]=process.env[k]; if (v == null) delete process.env[k]; else process.env[k]=String(v); }
  const restore=()=>{ for (const [k,v] of Object.entries(old)) { if (v===undefined) delete process.env[k]; else process.env[k]=v; } };
  try { const r=fn(); return r&&typeof r.then==='function'?r.finally(restore):(restore(),r); } catch(e){restore();throw e;}
}

function makeDb() {
  let seq = 0, eventSeq = 0, attemptSeq = 0, txSeq = 0;
  const agencies = new Map([
    ["agency-A", {id:"agency-A",name:"Agency A",plan:"PRO"}],
    ["agency-B", {id:"agency-B",name:"Agency B",plan:"PRO"}],
  ]);
  for (let i=0;i<60;i+=1) agencies.set(`agency-${i}`, {id:`agency-${i}`,name:`Agency ${i}`,plan:"PRO"});
  const orders = new Map();
  const events = new Map();
  const attempts = new Map(); // key mode:payment
  const wallets = new Map(); // agency:mode
  const walletTx = new Map(); // idempotency -> row
  const subs = new Map([
    ["agency-A", {id:"sub-A",agencyId:"agency-A",billingMode:"MANUAL"}],
    ["agency-B", {id:"sub-B",agencyId:"agency-B",billingMode:"MANUAL"}],
  ]);
  for (let i=0;i<60;i+=1) subs.set(`agency-${i}`, {id:`sub-${i}`,agencyId:`agency-${i}`,billingMode:"MANUAL"});
  const checkoutKey = (a,mode,key)=>`${a}|NOWPAYMENTS|${mode===true}|${key}`;
  const paymentKey = (mode,pid)=>`NOWPAYMENTS|${mode===true}|${pid}`;
  const walletKey = (a,mode)=>`${a}|${mode===true}`;
  function copy(x){return x?{...x}:x;}
  const db = {
    $transaction: async fn => fn(db),
    $queryRawUnsafe: async ()=>[],
    agency: { findUnique: async ({where})=>copy(agencies.get(where.id)||null) },
    agencySubscription: { findFirst: async ({where})=>copy(subs.get(where.agencyId)||null) },
    billingOrder: {
      findUnique: async ({where}) => {
        if (where.id) return copy(orders.get(where.id)||null);
        const w=where.agencyId_provider_testMode_checkoutKey;
        if (w) return copy([...orders.values()].find(o=>checkoutKey(o.agencyId,o.testMode,o.checkoutKey)===checkoutKey(w.agencyId,w.testMode,w.checkoutKey))||null);
        return null;
      },
      findFirst: async ({where}) => copy([...orders.values()].find(o=>(!where.id||o.id===where.id)&&(!where.agencyId||o.agencyId===where.agencyId))||null),
      findMany: async ({where={},orderBy,take=25}) => [...orders.values()].filter(o=>!where.agencyId||o.agencyId===where.agencyId).slice(0,take).map(copy),
      create: async ({data}) => {
        if ([...orders.values()].some(o=>checkoutKey(o.agencyId,o.testMode,o.checkoutKey)===checkoutKey(data.agencyId,data.testMode,data.checkoutKey))) { const e=new Error('unique'); e.code='P2002'; throw e; }
        const row={id:`order-${++seq}`,providerInvoiceId:null,providerInvoiceUrl:null,providerStatus:null,paidAt:null,activatedAt:null,createdAt:new Date(),updatedAt:new Date(),lines:[],...data}; orders.set(row.id,row); return copy(row);
      },
      update: async ({where,data}) => { const row=orders.get(where.id); assert.ok(row); Object.assign(row,data,{updatedAt:new Date()}); return copy(row); },
      updateMany: async ({where,data}) => { const row=orders.get(where.id); if(!row) return {count:0}; if(where.status!==undefined&&row.status!==where.status) return {count:0}; if(where.activatedAt===null&&row.activatedAt!==null) return {count:0}; Object.assign(row,data,{updatedAt:new Date()}); return {count:1}; },
    },
    billingPaymentAttempt: {
      findUnique: async ({where,include}) => { const w=where.provider_testMode_providerPaymentId; const r=attempts.get(paymentKey(w.testMode,w.providerPaymentId)); if(!r)return null; return {...r,...(include?.order?{order:copy(orders.get(r.orderId))}:{})}; },
      findFirst: async ({where,include}) => { const r=[...attempts.values()].filter(r=>(!where.orderId||r.orderId===where.orderId)&&(!where.providerPaymentId||r.providerPaymentId===where.providerPaymentId)&&(where.testMode===undefined||r.testMode===where.testMode)).sort((a,b)=>b.updatedAt-a.updatedAt)[0]; if(!r)return null; return {...r,...(include?.order?{order:copy(orders.get(r.orderId))}:{})}; },
      upsert: async ({where,create,update}) => { const w=where.provider_testMode_providerPaymentId; const k=paymentKey(w.testMode,w.providerPaymentId); let r=attempts.get(k); if(!r){r={id:`attempt-${++attemptSeq}`,createdAt:new Date(),updatedAt:new Date(),...create};attempts.set(k,r);} else {Object.assign(r,update,{updatedAt:new Date()});} return copy(r); },
    },
    billingProviderEvent: {
      create: async ({data}) => { if(events.has(data.eventKey)){const e=new Error('unique');e.code='P2002';throw e;} const r={id:`event-${++eventSeq}`,processedAt:null,processingError:null,paymentAttemptId:null,receivedAt:new Date(),...data};events.set(data.eventKey,r);return copy(r); },
      findUnique: async ({where})=>copy(events.get(where.eventKey)||null),
      update: async ({where,data})=>{ const entry=[...events.entries()].find(([,r])=>r.id===where.id);assert.ok(entry);Object.assign(entry[1],data);return copy(entry[1]); },
    },
    agencyBillingWallet: {
      upsert: async ({where,create})=>{const w=where.agencyId_testMode;const k=walletKey(w.agencyId,w.testMode);let r=wallets.get(k);if(!r){r={id:`wallet-${w.agencyId}-${w.testMode?'test':'live'}`,agencyId:w.agencyId,testMode:w.testMode,balanceCents:0n,currency:'USD',createdAt:new Date(),updatedAt:new Date(),...create};wallets.set(k,r);}return copy(r);},
      findUnique: async ({where})=>{const w=where.agencyId_testMode;if(w)return copy(wallets.get(walletKey(w.agencyId,w.testMode))||null);return [...wallets.values()].find(r=>r.id===where.id)||null;},
      update: async ({where,data})=>{const r=[...wallets.values()].find(r=>r.id===where.id);assert.ok(r);Object.assign(r,data,{updatedAt:new Date()});return copy(r);},
    },
    billingWalletTransaction: {
      findUnique: async ({where})=>copy(walletTx.get(where.idempotencyKey)||null),
      findMany: async ({where,take=100})=>[...walletTx.values()].filter(r=>(!where.agencyId||r.agencyId===where.agencyId)&&(where.testMode===undefined||r.testMode===where.testMode)).slice(0,take).map(copy),
      create: async ({data})=>{if(walletTx.has(data.idempotencyKey)){const e=new Error('unique');e.code='P2002';throw e;}const r={id:`wtx-${++txSeq}`,createdAt:new Date(),...data};walletTx.set(data.idempotencyKey,r);return copy(r);},
    },
    _orders:orders,_attempts:attempts,_events:events,_wallets:wallets,_walletTx:walletTx,
  };
  return db;
}

function loadServices(db) {
  const original = Module._load;
  let wallet;
  Module._load = function(request,parent,isMain){
    if(request==='../prisma') return db;
    if(request==='./audit-service') return {audit:async()=>null};
    if(request==='./billing-entitlement-service') return {
      addMonthsUtc:(d,m)=>new Date(new Date(d).setUTCMonth(new Date(d).getUTCMonth()+m)),
      isFuture:(d,n=new Date())=>!!d&&new Date(d)>new Date(n),
      lockAgencyBillingMutation:async()=>null,
      syncAgencyBillingAggregate:async()=>({status:'ACTIVE'}),
      activatePaidOrderEntitlements:async()=>null,
      refundOrderEntitlements:async()=>null,
    };
    if(request==='./billing-wallet-service' && wallet) return wallet;
    return original.call(this,request,parent,isMain);
  };
  try {
    delete require.cache[require.resolve(walletPath)]; wallet=require(walletPath);
    delete require.cache[require.resolve(nowPath)]; const now=require(nowPath);
    return {wallet,now};
  } finally { Module._load=original; }
}

const repoRoot = path.join(__dirname, "..", "..");

test('billing HTTP routes derive tenant only from authenticated session, never from request body', () => {
  const route = fs.readFileSync(path.join(repoRoot, 'src/routes/billing.js'), 'utf8');
  assert.match(route, /router\.use\(authRequired\);[\s\S]*router\.use\(ownerOnly\);/);
  const topUp = route.match(/router\.post\("\/wallet\/top-up"[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(topUp, /agencyId: req\.auth\.agencyId/);
  assert.doesNotMatch(topUp, /req\.body\?\.agencyId|req\.body\.agencyId/);
  const resume = route.match(/router\.post\("\/orders\/:orderId\/resume"[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(resume, /resumeCheckout\(\{ agencyId: req\.auth\.agencyId, orderId: req\.params\.orderId \}\)/);
  const reconcile = route.match(/router\.post\("\/orders\/:orderId\/reconcile"[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(reconcile, /reconcileOrder\(\{ agencyId: req\.auth\.agencyId, orderId: req\.params\.orderId/);
});

test('auth token agency is revalidated against an active membership before billing gets req.auth', () => {
  const auth = fs.readFileSync(path.join(repoRoot, 'src/middleware/auth.js'), 'utf8');
  assert.match(auth, /userId: decoded\.userId,[\s\S]*agencyId: decoded\.agencyId/);
  assert.match(auth, /deletedAt: null/);
  assert.match(auth, /deactivatedAt: null/);
  assert.match(auth, /agencyId: membership\.agencyId/);
});

test('database uniqueness fences checkout keys, wallets and provider payment ids by tenant/environment identity', () => {
  const schema = fs.readFileSync(path.join(repoRoot, 'prisma/schema.prisma'), 'utf8');
  assert.match(schema, /@@unique\(\[agencyId, provider, testMode, checkoutKey\]\)/);
  assert.match(schema, /model AgencyBillingWallet[\s\S]*@@unique\(\[agencyId, testMode\]\)/);
  assert.match(schema, /model BillingPaymentAttempt[\s\S]*@@unique\(\[provider, testMode, providerPaymentId\]\)/);
  assert.match(schema, /model BillingWalletTransaction[\s\S]*idempotencyKey\s+String\s+@unique/);
});

const env={NOWPAYMENTS_MODE:'sandbox',NOWPAYMENTS_API_KEY:'key',NOWPAYMENTS_IPN_SECRET:'secret',PUBLIC_BASE_URL:'https://api.example.com',NOWPAYMENTS_SANDBOX_ACTIVATE:'true',NODE_ENV:'test'};

function finished(order,paymentId,invoiceId){return {payment_id:paymentId,payment_status:'finished',order_id:order.id,invoice_id:invoiceId,price_amount:(order.amountCents/100).toFixed(2),price_currency:'usd',pay_amount:'60',pay_currency:'usdttrc20',actually_paid:'60'};}

test('two agencies can use the same checkout key and same amount without order/invoice reuse', async()=>withEnv(env,async()=>{
  const db=makeDb(); const {now}=loadServices(db); const oldFetch=global.fetch; const requests=[];
  global.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);requests.push(body); const n=requests.length; return {ok:true,status:200,text:async()=>JSON.stringify({invoice_id:`invoice-${n}`,invoice_url:`https://sandbox.nowpayments.io/payment/?iid=invoice-${n}`,order_id:body.order_id,price_amount:body.price_amount,price_currency:body.price_currency})};};
  try {
    const key='123e4567-e89b-42d3-a456-426614174000';
    const [a,b]=await Promise.all([
      now.createWalletTopUpCheckout({agencyId:'agency-A',actorUserId:'owner-A',checkoutKey:key,amountCents:6000,db}),
      now.createWalletTopUpCheckout({agencyId:'agency-B',actorUserId:'owner-B',checkoutKey:key,amountCents:6000,db}),
    ]);
    assert.notEqual(a.order.id,b.order.id); assert.notEqual(a.order.providerInvoiceId,b.order.providerInvoiceId); assert.equal(requests.length,2);
    assert.equal(db._orders.get(a.order.id).agencyId,'agency-A'); assert.equal(db._orders.get(b.order.id).agencyId,'agency-B');
  } finally {global.fetch=oldFetch;}
}));

test('resume is tenant-scoped: agency B cannot resume agency A order', async()=>withEnv(env,async()=>{
  const db=makeDb(); const {now}=loadServices(db); const oldFetch=global.fetch;
  global.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);return {ok:true,status:200,text:async()=>JSON.stringify({invoice_id:'inv-A',invoice_url:'https://sandbox.nowpayments.io/payment/?iid=inv-A',order_id:body.order_id,price_amount:body.price_amount,price_currency:'usd'})};};
  try { const a=await now.createWalletTopUpCheckout({agencyId:'agency-A',actorUserId:'owner-A',checkoutKey:'123e4567-e89b-42d3-a456-426614174001',amountCents:6000,db}); await assert.rejects(now.resumeCheckout({agencyId:'agency-B',orderId:a.order.id,db}),e=>e.code==='BILLING_ORDER_NOT_FOUND'); } finally {global.fetch=oldFetch;}
}));

test('finished payments credit only their own agency wallets, including concurrent same-amount payments', async()=>withEnv(env,async()=>{
  const db=makeDb(); const {now,wallet}=loadServices(db); const oldFetch=global.fetch; let n=0;
  global.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body); const i=++n;return {ok:true,status:200,text:async()=>JSON.stringify({invoice_id:`inv-${i}`,invoice_url:`https://sandbox.nowpayments.io/payment/?iid=inv-${i}`,order_id:body.order_id,price_amount:body.price_amount,price_currency:'usd'})};};
  try {
    const [a,b]=await Promise.all([
      now.createWalletTopUpCheckout({agencyId:'agency-A',actorUserId:'owner-A',checkoutKey:'123e4567-e89b-42d3-a456-426614174002',amountCents:6000,db}),
      now.createWalletTopUpCheckout({agencyId:'agency-B',actorUserId:'owner-B',checkoutKey:'123e4567-e89b-42d3-a456-426614174003',amountCents:6000,db}),
    ]);
    const oa=db._orders.get(a.order.id), ob=db._orders.get(b.order.id);
    await Promise.all([
      now.applyProviderPayment(finished(oa,'pay-A',oa.providerInvoiceId),{signature:'sig-A',signatureVerified:true,db}),
      now.applyProviderPayment(finished(ob,'pay-B',ob.providerInvoiceId),{signature:'sig-B',signatureVerified:true,db}),
    ]);
    const wa=await wallet.getWalletState({agencyId:'agency-A',testMode:true,db}); const wb=await wallet.getWalletState({agencyId:'agency-B',testMode:true,db});
    assert.equal(wa.wallet.balanceCents,6000); assert.equal(wb.wallet.balanceCents,6000);
    assert.equal(wa.transactions.length,1); assert.equal(wb.transactions.length,1);
    assert.equal(wa.transactions[0].orderId,a.order.id); assert.equal(wb.transactions[0].orderId,b.order.id);
  } finally {global.fetch=oldFetch;}
}));

test('duplicate callback cannot double-credit an agency wallet', async()=>withEnv(env,async()=>{
  const db=makeDb(); const {now,wallet}=loadServices(db); const oldFetch=global.fetch;
  global.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);return {ok:true,status:200,text:async()=>JSON.stringify({invoice_id:'inv-dupe',invoice_url:'https://sandbox.nowpayments.io/payment/?iid=inv-dupe',order_id:body.order_id,price_amount:body.price_amount,price_currency:'usd'})};};
  try { const a=await now.createWalletTopUpCheckout({agencyId:'agency-A',actorUserId:'owner-A',checkoutKey:'123e4567-e89b-42d3-a456-426614174004',amountCents:6000,db}); const o=db._orders.get(a.order.id); const p=finished(o,'pay-dupe',o.providerInvoiceId); await now.applyProviderPayment(p,{signature:'same',signatureVerified:true,db}); const r2=await now.applyProviderPayment(p,{signature:'same',signatureVerified:true,db}); assert.equal(r2.duplicate,true); const w=await wallet.getWalletState({agencyId:'agency-A',testMode:true,db}); assert.equal(w.wallet.balanceCents,6000); assert.equal(w.transactions.length,1); } finally {global.fetch=oldFetch;}
}));

test('provider payment_id already bound to agency A cannot be rebound to agency B even for same amount', async()=>withEnv(env,async()=>{
  const db=makeDb(); const {now,wallet}=loadServices(db); const oldFetch=global.fetch; let n=0;
  global.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body); const i=++n;return {ok:true,status:200,text:async()=>JSON.stringify({invoice_id:`inv-x${i}`,invoice_url:`https://sandbox.nowpayments.io/payment/?iid=inv-x${i}`,order_id:body.order_id,price_amount:body.price_amount,price_currency:'usd'})};};
  try { const a=await now.createWalletTopUpCheckout({agencyId:'agency-A',actorUserId:'owner-A',checkoutKey:'123e4567-e89b-42d3-a456-426614174005',amountCents:6000,db}); const b=await now.createWalletTopUpCheckout({agencyId:'agency-B',actorUserId:'owner-B',checkoutKey:'123e4567-e89b-42d3-a456-426614174006',amountCents:6000,db}); const oa=db._orders.get(a.order.id), ob=db._orders.get(b.order.id); await now.applyProviderPayment(finished(oa,'shared-payment',oa.providerInvoiceId),{signature:'a',signatureVerified:true,db}); await assert.rejects(now.applyProviderPayment(finished(ob,'shared-payment',ob.providerInvoiceId),{signature:'b',signatureVerified:true,db}),e=>e.code==='BILLING_PROVIDER_PAYMENT_ORDER_MISMATCH'); const wa=await wallet.getWalletState({agencyId:'agency-A',testMode:true,db}); const wb=await wallet.getWalletState({agencyId:'agency-B',testMode:true,db}); assert.equal(wa.wallet.balanceCents,6000); assert.equal(wb.wallet.balanceCents,0); } finally {global.fetch=oldFetch;}
}));

test('wrong order_id cannot credit another agency, even when fiat amount is identical', async()=>withEnv(env,async()=>{
  const db=makeDb(); const {now,wallet}=loadServices(db); const oldFetch=global.fetch; let n=0;
  global.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);const i=++n;return {ok:true,status:200,text:async()=>JSON.stringify({invoice_id:`inv-z${i}`,invoice_url:`https://sandbox.nowpayments.io/payment/?iid=inv-z${i}`,order_id:body.order_id,price_amount:body.price_amount,price_currency:'usd'})};};
  try { const a=await now.createWalletTopUpCheckout({agencyId:'agency-A',actorUserId:'owner-A',checkoutKey:'123e4567-e89b-42d3-a456-426614174007',amountCents:6000,db}); const b=await now.createWalletTopUpCheckout({agencyId:'agency-B',actorUserId:'owner-B',checkoutKey:'123e4567-e89b-42d3-a456-426614174008',amountCents:6000,db}); const oa=db._orders.get(a.order.id), ob=db._orders.get(b.order.id); const spoof={...finished(oa,'pay-spoof',oa.providerInvoiceId),order_id:ob.id,invoice_id:oa.providerInvoiceId}; await assert.rejects(now.applyProviderPayment(spoof,{signature:'spoof',signatureVerified:true,db}),e=>e.code==='BILLING_PROVIDER_INVOICE_MISMATCH'); const wa=await wallet.getWalletState({agencyId:'agency-A',testMode:true,db}); const wb=await wallet.getWalletState({agencyId:'agency-B',testMode:true,db}); assert.equal(wa.wallet.balanceCents,0); assert.equal(wb.wallet.balanceCents,0); } finally {global.fetch=oldFetch;}
}));


test('50 agencies can create and settle same-amount top-ups concurrently without cross-credit', async()=>withEnv(env,async()=>{
  const db=makeDb(); const {now,wallet}=loadServices(db); const oldFetch=global.fetch; let invoiceSeq=0;
  global.fetch=async(_url,opts)=>{const body=JSON.parse(opts.body);const i=++invoiceSeq;return {ok:true,status:200,text:async()=>JSON.stringify({invoice_id:`bulk-inv-${i}`,invoice_url:`https://sandbox.nowpayments.io/payment/?iid=bulk-inv-${i}`,order_id:body.order_id,price_amount:body.price_amount,price_currency:'usd'})};};
  try {
    const agencies=Array.from({length:50},(_,i)=>`agency-${i}`);
    const checkouts=await Promise.all(agencies.map((agencyId,i)=>now.createWalletTopUpCheckout({agencyId,actorUserId:`owner-${i}`,checkoutKey:`bulk-checkout-key-${String(i).padStart(3,'0')}-abcdefghijklmnop`,amountCents:6000,db})));
    assert.equal(new Set(checkouts.map(x=>x.order.id)).size,50);
    assert.equal(new Set(checkouts.map(x=>x.order.providerInvoiceId)).size,50);
    await Promise.all(checkouts.map((x,i)=>{const o=db._orders.get(x.order.id);return now.applyProviderPayment(finished(o,`bulk-pay-${i}`,o.providerInvoiceId),{signature:`bulk-sig-${i}`,signatureVerified:true,db});}));
    for (let i=0;i<50;i+=1){const state=await wallet.getWalletState({agencyId:`agency-${i}`,testMode:true,db});assert.equal(state.wallet.balanceCents,6000,`agency-${i}`);assert.equal(state.transactions.length,1,`agency-${i} tx`);assert.equal(state.transactions[0].orderId,checkouts[i].order.id,`agency-${i} order`);}    
    assert.equal(db._walletTx.size,50);
  } finally {global.fetch=oldFetch;}
}));
