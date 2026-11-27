"use strict";

// Provider notification and payout identifiers are different namespaces. Their
// textual equality is never evidence of one operation, even for one creator.
const KEY = "team_tip_identity_adoption_v4";
const fail = code => Object.assign(new Error(code), { code });
function aliases(tip) {
  return [["creator_tip", tip.id], ["notification", tip.externalNotificationId],
    ["transaction", tip.externalTransactionId], ["event", tip.eventFingerprint]]
    .filter(([, value]) => typeof value === "string" && value.trim())
    .map(([namespace, externalId]) => ({ namespace, externalId: externalId.trim() }));
}
function compatible(root, tip) {
  return Boolean(root && root.agencyId === tip.agencyId && (root.creatorId || root.accountId) === tip.creatorId
    && (!root.creatorTipId || root.creatorTipId === tip.id));
}
async function find(db, tip) {
  if (typeof db.$queryRawUnsafe !== "function") return null;
  const rows = await db.$queryRawUnsafe(`SELECT DISTINCT a."rootId" FROM "TeamTipAlias" a
    JOIN jsonb_to_recordset($3::jsonb) x(namespace text,"externalId" text)
      ON a.namespace=x.namespace AND a."externalId"=x."externalId"
    WHERE a."agencyId"=$1 AND a."creatorId"=$2`, tip.agencyId, tip.creatorId, JSON.stringify(aliases(tip)));
  if (rows.length > 1) throw fail("TEAM_TIP_ALIAS_CONFLICT");
  if (!rows.length) return null;
  return { rootId: rows[0].rootId, root: await db.teamTipLedger.findUnique({ where: { id: rows[0].rootId } }) };
}
async function bind(db, tip, root) {
  if (!compatible(root, tip)) throw fail("TEAM_TIP_ROOT_SCOPE_MISMATCH");
  if (typeof db.$queryRawUnsafe !== "function") return;
  const refs = aliases(tip);
  await db.$executeRawUnsafe(`INSERT INTO "TeamTipAlias"("agencyId","creatorId",namespace,"externalId","rootId")
    SELECT $1,$2,x.namespace,x."externalId",$3 FROM jsonb_to_recordset($4::jsonb) x(namespace text,"externalId" text)
    ORDER BY x.namespace,x."externalId" ON CONFLICT DO NOTHING`, tip.agencyId, tip.creatorId, root.id, JSON.stringify(refs));
  const conflicts = await db.$queryRawUnsafe(`SELECT a."rootId" FROM "TeamTipAlias" a
    JOIN jsonb_to_recordset($4::jsonb) x(namespace text,"externalId" text)
      ON a.namespace=x.namespace AND a."externalId"=x."externalId"
    WHERE a."agencyId"=$1 AND a."creatorId"=$2 AND a."rootId"<>$3 LIMIT 1`, tip.agencyId, tip.creatorId, root.id, JSON.stringify(refs));
  if (conflicts.length) throw fail("TEAM_TIP_ALIAS_CONFLICT");
}
async function legacyAmbiguous(db,tip) {
  if(!db.creatorTip.findFirst)return false;
  const ids=aliases(tip).map(row=>row.externalId);
  return Boolean(await db.creatorTip.findFirst({where:{agencyId:tip.agencyId,id:{not:tip.id},OR:[
    {externalNotificationId:{in:ids}},{externalTransactionId:{in:ids}},{eventFingerprint:{in:ids}},{id:{in:ids}},
  ]},select:{id:true}}));
}

// Enumerate retained canonical tips once. Missing roots are reconstructed from
// exact current message evidence; legacy bare external IDs are never adopted.
async function adoptPage(db) {
  return require("./db-commit-kernel").runRootCommit(db, async ({ tx }) => {
    const [state] = await tx.$queryRawUnsafe('SELECT * FROM "MaintenanceLaneState" WHERE key=$1 AND "completedAt" IS NULL FOR UPDATE SKIP LOCKED', KEY);
    if (!state) return { complete: true, selected: 0 };
    const rows = await tx.creatorTip.findMany({ where: { id: { gt: state.cursor.afterId || "", lte: state.cursor.upperId } },
      orderBy: { id: "asc" }, take: 100, select: { id: true, agencyId: true, creatorId: true } });
    for (const tip of rows) {
      const life = await require("./agency-lifecycle-barrier-service").lockAgencyLifecycleBarrier({ db: tx, agencyId: tip.agencyId });
      if (!life.row || life.row.deletedAt) continue;
      await require("./domain-work-authority-service").publishDomainWork({ db: tx, ...tip, objectId: tip.id,
        objectType: "CreatorTip", workClass: "TEAM_MONEY_RECONCILIATION", partitionKey: tip.creatorId });
    }
    const complete = rows.length < 100;
    await tx.maintenanceLaneState.update({ where: { key: KEY }, data: {
      cursor: { ...state.cursor, afterId: rows.at(-1)?.id || state.cursor.afterId }, completedAt: complete ? new Date() : null,
    } });
    return { complete, selected: rows.length };
  }, { profile: "JOB_CHUNK", authority: { kind: "TEAM_TIP_IDENTITY_ADOPTION" } });
}
module.exports = { KEY, aliases, compatible, find, bind, legacyAmbiguous, adoptPage };
