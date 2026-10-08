'use strict';
// Shared identity contract for handoff, execution, retention and retirement.
const object = x => x && typeof x === 'object' && !Array.isArray(x) ? x : {};
const text = x => typeof x === 'string' && x.length > 0;
const SETTLED_CODES = Object.freeze(['unfollowed', 'already_unfollowed', 'unfollowed_recovered']);
function isCleanup(d) { return d?.moduleKey === 'sfs' && d.actionType === 'SFS_UNFOLLOW_TARGET'; }
function isLegacyCleanup(d) { return isCleanup(d) && object(d.payload).legacyMigration === true; }
function isSettledCleanup(d) {
  return isCleanup(d) && d.status === 'COMPLETED' && SETTLED_CODES.includes(object(d.result).code)
    && Boolean(d.finishedAt) && (object(d.result).code === 'already_unfollowed' || Boolean(d.writeCommitAt));
}
function matchesSfsAttestation({ proof:p, delivery:d, candidate:c, providerSubject }) {
  const payload=object(d?.payload), evidence=object(p?.evidence), metadata=object(c?.metadata);
  if (!p || !d || !c || !text(providerSubject) || !isLegacyCleanup(d)
      || p.id !== d.legacyCleanupProofId || p.kind !== 'SFS_CLEANUP' || p.cohortId !== 'automation_job'
      || p.classifierVersion !== 1 || !/^[a-f0-9]{64}$/.test(p.sourceHash || '')
      || !['AutomationJob','AutomationDelivery'].includes(p.sourceTable)
      || p.sourceId !== (p.sourceTable === 'AutomationJob' ? payload.sourceJobId : d.id)
      || p.deliveryId !== d.id || p.agencyId !== d.agencyId || p.creatorId !== d.creatorId
      || p.targetId !== d.targetId || p.targetId !== d.fanId || p.generation !== d.generation
      || !Number.isSafeInteger(p.generation) || p.generation < 1
      || c.agencyId !== d.agencyId || c.creatorId !== d.creatorId || c.targetUserId !== d.targetId
      || c.safetyUnfollowDeliveryId !== d.id || evidence.candidateId !== c.id || payload.candidateId !== c.id
      || p.providerSubject !== providerSubject) return false;
  const admissible = evidence.basis === 'CURRENT_FOLLOW_RECEIPT' ? text(evidence.followDeliveryId)
    : /^P14_ACCEPTED_COMPENSATION:[a-f0-9]{64}$/.test(evidence.basis || '') && evidence.followDeliveryId === null;
  return Boolean(admissible) && !(metadata.followEffectOwnership === 'OWNED' && metadata.followEffectDeliveryId
    && metadata.followEffectDeliveryId !== evidence.followDeliveryId);
}
function matchesSettlementProof(p,d) {
  return p?.kind === 'SETTLED' && p.cohortId === 'automation_job' && p.sourceTable === 'AutomationDelivery'
    && p.sourceId === d?.id && p.deliveryId === d.id && p.agencyId === d.agencyId
    && p.creatorId === d.creatorId && p.targetId === d.targetId && p.generation === d.generation
    && p.classifierVersion === 1 && p.evidence?.basis === 'CURRENT_CLEANUP_RECEIPT'
    && SETTLED_CODES.includes(p.evidence.outcomeCode) && p.evidence.outcomeCode === object(d.result).code
    && new Date(p.evidence.finishedAt).getTime() === new Date(d.finishedAt).getTime()
    && (p.evidence.writeCommitAt === null ? !d.writeCommitAt : new Date(p.evidence.writeCommitAt).getTime() === new Date(d.writeCommitAt).getTime())
    && p.evidence.cleanupProofId === d.legacyCleanupProofId;
}
// Historical completion is independent of mutable candidate/provider rows.
// Only the immutable execution attestation and its exact settlement can close a
// frozen source after history retention has removed the delivery itself.
function matchesSettledAttestation(p,a) {
  const e=object(p?.evidence), ae=object(a?.evidence);
  return p?.kind==='SETTLED' && a?.kind==='SFS_CLEANUP'
    && p.cohortId==='automation_job' && a.cohortId==='automation_job'
    && p.classifierVersion===1 && a.classifierVersion===1
    && /^[a-f0-9]{64}$/.test(p.sourceHash||'') && /^[a-f0-9]{64}$/.test(a.sourceHash||'')
    && p.sourceTable==='AutomationDelivery' && p.sourceId===a.deliveryId && p.deliveryId===a.deliveryId
    && text(a.deliveryId) && p.agencyId===a.agencyId && p.creatorId===a.creatorId
    && p.targetId===a.targetId && p.providerSubject===a.providerSubject && text(p.providerSubject)
    && p.generation===a.generation && Number.isSafeInteger(p.generation) && p.generation>0
    && e.basis==='CURRENT_CLEANUP_RECEIPT' && e.cleanupProofId===a.id
    && e.candidateId===ae.candidateId && text(e.candidateId) && SETTLED_CODES.includes(e.outcomeCode)
    && text(e.finishedAt) && Number.isFinite(new Date(e.finishedAt).getTime())
    && (e.outcomeCode==='already_unfollowed' || (text(e.writeCommitAt) && Number.isFinite(new Date(e.writeCommitAt).getTime())))
    && (ae.basis==='CURRENT_FOLLOW_RECEIPT' ? text(ae.followDeliveryId)
      : /^P14_ACCEPTED_COMPENSATION:[a-f0-9]{64}$/.test(ae.basis||'') && ae.followDeliveryId===null);
}
// SQL fragments are static application constants, never request data. The same
// predicates also define narrow online indexes for operator/lifecycle queries.
const LEGACY_SQL = `"moduleKey"='sfs' AND "actionType"='SFS_UNFOLLOW_TARGET' AND "payload"->>'legacyMigration'='true'`;
const SETTLED_SQL = `"status"='COMPLETED' AND "finishedAt" IS NOT NULL AND COALESCE("result"->>'code','') IN ('unfollowed','already_unfollowed','unfollowed_recovered') AND ("result"->>'code'='already_unfollowed' OR "writeCommitAt" IS NOT NULL)`;
const UNSETTLED_SQL = `"moduleKey"='sfs' AND "actionType"='SFS_UNFOLLOW_TARGET' AND NOT (${SETTLED_SQL})`;
module.exports={SETTLED_CODES,isCleanup,isLegacyCleanup,isSettledCleanup,matchesSfsAttestation,matchesSettlementProof,matchesSettledAttestation,
  LEGACY_SQL,SETTLED_SQL,UNSETTLED_SQL};
