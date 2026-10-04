"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const prisma=require.resolve("../prisma");
require.cache[prisma]={id:prisma,filename:prisma,loaded:true,exports:{}};
const {readCampaignPage,metricsDto}=require("./campaign-read-repository");

test("populated Campaign coverage crosses JSON with exact bigint revisions and unchanged DB values",async()=>{
  const revision=9007199254740993n,now=new Date("2026-10-04T00:00:00.000Z");
  const campaigns={status:"PARTIAL",campaignDirectoryFactsRevision:revision,campaignDirectoryCountRevision:revision-1n,
    membershipObservedAt:now,fanValueExpected:3,fanValueOutstanding:1};
  const db={
    $queryRawUnsafe:async(sql)=>sql.includes('FROM "CreatorFanRefreshDemand"') ? [{queued:false,failed:false}] : [{generation:1,activeGeneration:1,empty:true,pending:false,expired:false,valueFreshnessMs:3600000}],
    creatorFinancialCollectionState:{findUnique:async()=>null},
    creatorCampaignCollectionState:{findUnique:async()=>campaigns},
    creatorCampaign:{findMany:async()=>[]},
  };
  const result=await readCampaignPage({db,creatorId:"creator",now});
  const wire=JSON.parse(JSON.stringify(result));
  assert.equal(wire.sourceCoverage.campaigns.campaignDirectoryFactsRevision,"9007199254740993");
  assert.equal(wire.sourceCoverage.campaigns.campaignDirectoryCountRevision,"9007199254740992");
  assert.equal(wire.sourceCoverage.campaigns.membershipObservedAt,now.toISOString());
  assert.equal(wire.sourceCoverage.campaigns.fanValueOutstanding,1);
  assert.equal(campaigns.campaignDirectoryFactsRevision,revision);
  assert.equal(wire.totals.netCents,0);
});
test("opaque revision serialization does not relax safe monetary JSON bounds",()=>{
  assert.throws(()=>metricsDto({knownNetCents:"9007199254740993"}),e=>e.code==="CAMPAIGN_AMOUNT_OUT_OF_SAFE_RANGE");
  assert.equal(metricsDto({knownNetCents:"0",unknownNetTransactions:"1"}).netCents,null);
});
