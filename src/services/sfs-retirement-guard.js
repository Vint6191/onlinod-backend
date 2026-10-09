"use strict";
const contract = require("./sfs-cleanup-contract");
const failure = (code, details = {}) => Object.assign(new Error(code), { code, status: 409, ...details });
async function assertSfsRetirable({db,agencyId,creatorId=null}) {
  if (!db?.$queryRawUnsafe || typeof db.$transaction === "function") throw failure("SFS_TRANSACTION_REQUIRED");
  const values=creatorId?[agencyId,creatorId]:[agencyId];
  const scope=`"agencyId"=$1${creatorId?' AND "creatorId"=$2':''}`;
  const checks=[
    `SELECT "id" FROM "AutomationDelivery" WHERE ${scope} AND ${contract.UNSETTLED_SQL} LIMIT 1`,
    `SELECT "id" FROM "AutomationDelivery" WHERE ${scope} AND "moduleKey"='sfs' AND "actionType"='SFS_FOLLOW_TARGET'
      AND "status" IN ('CLAIMED','RUNNING','COMMITTING','RECONCILE_REQUIRED') LIMIT 1`,
    `SELECT "id" FROM "SfsTargetCandidate" WHERE ${scope} AND "completedAt" IS NULL
      AND "metadata"->>'followEffectOwnership'='OWNED' LIMIT 1`,
  ];
  for(const sql of checks){const rows=await db.$queryRawUnsafe(sql,...values);if(rows.length)throw failure('SFS_CLEANUP_BLOCKS_RETIREMENT',{
    message:'Finish or reconcile SFS cleanup before removing this creator or agency.',objectId:rows[0].id});}
}
module.exports = { assertSfsRetirable };
