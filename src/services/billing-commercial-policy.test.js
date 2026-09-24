"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),Module=require("node:module");
const {policyFixture}=require("../../scripts/test-support/commercial-policy-fixture");
const {readCommercialPolicy,commercialSettingsSchema}=require("./billing-commercial-policy-service");
const {configuredPrices}=require("./billing-catalog-service");
const realPricing=require("./billing-wallet-service").pricingPreviewFromRevenue;
function settingsService(){
 const original=Module._load;
 Module._load=function(request,parent,isMain){
  if(request==="./billing-wallet-service")return{getWalletState:async()=>({wallet:{balanceCents:0},transactions:[]}),readRolling30dRevenueBatch:async({creatorIds})=>new Map(creatorIds.map(id=>[id,{fresh:true,revenue30dCents:50000,capturedAt:new Date(),source:"canonical"}])),pricingPreviewFromRevenue:realPricing};
  if(request==="./billing-nowpayments-service")return{publicProviderConfig:()=>({testMode:false,checkoutAvailable:false}),recentOrders:async()=>[]};
  if(request==="./team-access-control")return{isOwner:member=>member.role==="OWNER"};
  return original.call(this,request,parent,isMain);
 };
 try{delete require.cache[require.resolve("./settings-service")];return require("./settings-service");}finally{Module._load=original;}
}
function fixture(){
 let reads=0;const now=new Date("2026-09-24T00:00:00Z");
 const policy={revision:6,settings:{...policyFixture().settings,starterPriceCents:2750,aiChatterPriceCents:12500}};
 const agency={id:"a",name:"Agency",status:"TRIAL",trialEndsAt:new Date("2026-10-01"),billingSupportHold:false};
 const creators=[{id:"c1",agencyId:"a",billingProfile:{tier:"STARTER",tierMode:"AUTO",corePriceCents:1,aiChatterEnabled:true,aiChatterPriceCents:1}},{id:"c2",agencyId:"a",billingProfile:{tier:"STARTER",tierMode:"MANUAL",corePriceOverrideCents:1000,aiChatterEnabled:true,aiChatterPriceOverrideCents:0}}];
 const db={$queryRawUnsafe:async()=>[{authorityNow:now}],systemSetting:{findUnique:async()=>{reads++;return{revision:policy.revision,value:policy.settings};}},agency:{findUnique:async()=>agency},agencySubscription:{findFirst:async()=>({id:"sub",status:"TRIAL",billingMode:"MANUAL"})},creatorAccount:{findMany:async()=>creators}};
 return{db,agency,creators,policy,reads:()=>reads};
}
test("Settings uses one global revision for catalog and all creator prices; overrides remain explicit",async()=>{
 const f=fixture();const r=await settingsService().getBillingSettings({agencyId:"a",member:{role:"OWNER"},db:f.db});
 assert.equal(f.reads(),1);assert.equal(r.catalog.commercialPolicyRevision,6);assert.equal(r.catalog.tiers[0].priceCents,2750);
 assert.equal(r.creators[0].corePriceCents,2750);assert.equal(r.creators[0].aiChatterPriceCents,12500);assert.equal(r.creators[0].estimatedNextChargeCents,15250);
 assert.equal(r.creators[1].corePriceCents,1000);assert.equal(r.creators[1].aiChatterPriceCents,0);assert.equal(r.monthlyTotalCents,16250);
});
test("disabled addon displays its current catalog price without charging it",async()=>{
 const f=fixture();f.creators[0].billingProfile.aiChatterEnabled=false;const r=await settingsService().getBillingSettings({agencyId:"a",member:{role:"OWNER"},db:f.db});assert.equal(r.creators[0].aiChatterPriceCents,12500);assert.equal(r.creators[0].estimatedNextChargeCents,2750);
});
test("Settings preserves support hold and expires trials even without a subscription projection",async()=>{
 const f=fixture(),svc=settingsService();f.agency.billingSupportHold=true;f.creators[0].billingEntitlement={coreValidUntil:new Date("2027-01-01"),corePriceCents:2000};
 let r=await svc.getBillingSettings({agencyId:"a",member:{role:"OWNER"},db:f.db});assert.equal(r.agency.status,"LOCKED");assert.equal(r.subscription.effectiveStatus,"LOCKED");
 f.agency.billingSupportHold=false;f.agency.trialEndsAt=new Date("2026-09-01");f.creators.length=0;f.db.agencySubscription.findFirst=async()=>null;
 r=await svc.getBillingSettings({agencyId:"a",member:{role:"OWNER"},db:f.db});assert.equal(r.agency.status,"PAST_DUE");assert.equal(r.subscription,null);
});
test("non-owner billing read never loads policy or exposes prices",async()=>{const f=fixture();assert.deepEqual(await settingsService().getBillingSettings({agencyId:"a",member:{role:"CHATTER"},db:f.db}),{available:false,reason:"OWNER_ONLY"});assert.equal(f.reads(),0);});
test("policy authority fails closed on invalid revision, missing fields and unexpected fields",async()=>{
 for(const row of [null,{revision:0,value:policyFixture().settings},{revision:2,value:{...policyFixture().settings,trialDays:null}},{revision:2,value:{...policyFixture().settings,extra:true}}])await assert.rejects(readCommercialPolicy({db:{systemSetting:{findUnique:async()=>row}}}),{code:"BILLING_COMMERCIAL_POLICY_UNAVAILABLE"});
 assert.equal(commercialSettingsSchema.safeParse({...policyFixture().settings,outreachPriceCents:0}).success,true);
 assert.throws(()=>configuredPrices(null,null),{code:"BILLING_COMMERCIAL_POLICY_REQUIRED"});
});
