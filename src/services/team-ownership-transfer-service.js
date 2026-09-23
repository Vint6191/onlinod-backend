"use strict";
const crypto = require("node:crypto");
const { z } = require("zod");
const { runDbTransaction, lockDbAdvisoryXact } = require("./db-transaction-service");
const { lockTeamControlPlaneTopology } = require("./team-control-plane-authority-service");
const { lockTeamRoleLifecycle } = require("./team-administration-service");
const { isOwner, memberRoleKey } = require("./team-access-control");
const { requireOwnerCryptoCommitActor, normalizeWrapEnvelope, revokeOwnerRootAccessForMember } = require("./client-e2e-keyring-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { publishDesktopControlEvent } = require("./desktop-control-events");
const id = z.string().trim().min(1).max(180);
const transferSchema = z.object({
  commandId: z.string().uuid(), memberId: id,
  expectedOwnerEpoch: z.number().int().positive(), expectedTargetEpoch: z.number().int().positive(),
  expectedRootVersion: z.number().int().positive().nullable(),
  targetDeviceId: id.optional(), targetFingerprint: id.optional(),
  actorProof: z.string().min(1).max(256).optional(),
  ownerWrap: z.object({ algorithm:z.string().max(128), ephemeralPublicKey:z.string().max(4096), ciphertext:z.string().max(256), iv:z.string().max(64), tag:z.string().max(64) }).strict().optional(),
}).strict();
function fail(code, message, status=409) { throw Object.assign(new Error(message), {code,status}); }
async function transaction(db, work) {
  try { return await runDbTransaction(db, work, {isolationLevel:"Serializable"}); }
  catch (error) { if (error?.code === "P2034") fail("OWNERSHIP_TRANSFER_CONFLICT", "Ownership changed concurrently; reload before retrying"); throw error; }
}
async function requireDirectOwnerSession(tx, {agencyId,userId,actorDeviceId,authorizationSessionId}) {
  if (!actorDeviceId || !authorizationSessionId) fail("OWNERSHIP_DIRECT_SESSION_REQUIRED","Sign in with a current Desktop session before transferring ownership",403);
  const now = await dbAuthorityNow({db:tx});
  const session = await tx.refreshSession.findFirst({where:{agencyId,userId,deviceId:actorDeviceId,authorizationSessionId,impersonatedByAdminId:null,revokedAt:null,expiresAt:{gt:now}},select:{id:true}});
  if (!session) fail("OWNERSHIP_DIRECT_SESSION_REQUIRED","Ownership transfer requires your own active session; support sessions cannot transfer ownership",403);
}
async function participants(tx, agencyId, userId, memberId) {
  const actor = await tx.agencyMember.findFirst({where:{agencyId,userId,deletedAt:null,deactivatedAt:null},include:{user:true}});
  if (!actor || actor.user?.disabledAt || !isOwner(actor)) fail("OWNER_REQUIRED","Only the current OWNER can transfer ownership",403);
  const owners = await tx.agencyMember.count({where:{agencyId,deletedAt:null,OR:[{roleKey:"owner"},{role:"OWNER"}]}});
  if (owners !== 1) fail("OWNERSHIP_INVARIANT_CONFLICT","Agency must have exactly one OWNER before a transfer");
  const target = await tx.agencyMember.findFirst({where:{id:memberId,agencyId,deletedAt:null,deactivatedAt:null},include:{user:true}});
  if (!target || target.user?.disabledAt) fail("OWNERSHIP_TARGET_INACTIVE","Recipient must be an active member of this agency");
  if (target.id === actor.id || isOwner(target)) fail("OWNERSHIP_TARGET_INVALID","Choose another active member");
  return {actor,target};
}
async function ownershipTransferPlan({db,agencyId,userId,memberId,actorDeviceId=null,authorizationSessionId=null}) {
  return transaction(db, async tx => {
    await lockTeamControlPlaneTopology({tx,agencyId});
    await requireDirectOwnerSession(tx,{agencyId,userId,actorDeviceId,authorizationSessionId});
    const {actor,target} = await participants(tx,agencyId,userId,memberId);
    const root = await tx.agencyCryptoRoot.findUnique({where:{agencyId}});
    let identity = null;
    if (root) {
      if (root.status !== "ACTIVE") fail("CRYPTO_ROOT_NOT_ACTIVE","Agency encryption root is not active");
      // One enrolled device is sufficient for initial handover; the new owner can
      // subsequently enrol their other devices through the existing keyring owner.
      identity = await tx.deviceCryptoIdentity.findFirst({where:{agencyId,userId:target.userId,status:"ACTIVE",revokedAt:null},orderBy:[{updatedAt:"desc"},{deviceId:"asc"}]});
      if (!identity) fail("OWNERSHIP_TARGET_DEVICE_REQUIRED","Recipient must sign in and have a device approved before ownership transfer");
    }
    return {ok:true,memberId:target.id,expectedOwnerEpoch:actor.accessEpoch,expectedTargetEpoch:target.accessEpoch,
      expectedRootVersion:root?.version ?? null,targetDevice:identity?{deviceId:identity.deviceId,publicKey:identity.publicKey,fingerprint:identity.fingerprint}:null};
  });
}
async function transferOwnership({db,agencyId,userId,actorDeviceId=null,authorizationSessionId=null,input}) {
  const command = transferSchema.parse(input);
  // Ciphertext/proof never enters audit. Stable intent excludes re-randomized wrap
  // bytes; after success an identical identity/epoch request returns the receipt.
  const intent = {memberId:command.memberId,ownerEpoch:command.expectedOwnerEpoch,targetEpoch:command.expectedTargetEpoch,
    rootVersion:command.expectedRootVersion,targetDeviceId:command.targetDeviceId||null,targetFingerprint:command.targetFingerprint||null};
  const intentHash = crypto.createHash("sha256").update(JSON.stringify(intent)).digest("hex");
  const receiptId = `ownership:${command.commandId}`;
  const outcome = await transaction(db, async tx => {
    await lockDbAdvisoryXact({db:tx,key:receiptId,mode:"exclusive"});
    await requireDirectOwnerSession(tx,{agencyId,userId,actorDeviceId,authorizationSessionId});
    const previous = await tx.auditLog.findUnique({where:{id:receiptId}});
    if (previous) {
      if (previous.agencyId!==agencyId || previous.actorUserId!==userId || previous.action!=="team.ownership.transferred" || previous.metadata?.intentHash!==intentHash) fail("OWNERSHIP_COMMAND_CONFLICT","Command identity has already been used");
      return {body:previous.metadata.result,replayed:true,members:[]};
    }
    await lockTeamControlPlaneTopology({tx,agencyId});
    const {actor,target} = await participants(tx,agencyId,userId,command.memberId);
    for (const roleKey of [...new Set(["chatter","owner",memberRoleKey(target)])].sort()) await lockTeamRoleLifecycle({tx,agencyId,roleKey,mode:"share",agencyAlreadyLocked:true});
    // Neither [] nor broad "all" introduces explicit Creator IDs. The current
    // phase2_fence_creator_access_scope trigger locks only newly introduced IDs,
    // so this transfer does not enumerate the creator catalog or old history.
    // User lifecycle writers lock User first. Acquire both Users in stable order
    // before member rows; role and topology fences are already held.
    if (typeof tx.$queryRawUnsafe === "function") {
      for (const uid of [actor.userId,target.userId].sort()) await tx.$queryRawUnsafe('SELECT "id" FROM "User" WHERE "id"=$1 AND "disabledAt" IS NULL FOR SHARE',uid);
      for (const mid of [actor.id,target.id].sort()) await tx.$queryRawUnsafe('SELECT "id" FROM "AgencyMember" WHERE "id"=$1 AND "agencyId"=$2 FOR UPDATE',mid,agencyId);
    }
    if (actor.accessEpoch!==command.expectedOwnerEpoch || target.accessEpoch!==command.expectedTargetEpoch) fail("OWNERSHIP_REVISION_CONFLICT","Member access changed; reload before transferring");
    const root = await tx.agencyCryptoRoot.findUnique({where:{agencyId}});
    if ((root?.version ?? null)!==command.expectedRootVersion) fail("CRYPTO_APPROVAL_ROOT_VERSION_CONFLICT","Encryption generation changed; reload the transfer plan");
    const now = await dbAuthorityNow({db:tx});
    if (root) {
      const approver = await requireOwnerCryptoCommitActor({db:tx,agencyId,userId,member:actor,deviceId:actorDeviceId,actorProof:command.actorProof});
      const identity = command.targetDeviceId ? await tx.deviceCryptoIdentity.findUnique({where:{agencyId_deviceId:{agencyId,deviceId:command.targetDeviceId}}}) : null;
      const device = command.targetDeviceId ? await tx.workerDevice.findUnique({where:{id:command.targetDeviceId}}) : null;
      if (!identity || identity.userId!==target.userId || identity.status!=="ACTIVE" || identity.revokedAt || identity.fingerprint!==command.targetFingerprint || !device || device.agencyId!==agencyId || device.userId!==target.userId) fail("OWNERSHIP_TARGET_DEVICE_CHANGED","Recipient device changed; reload the transfer plan");
      const envelope = normalizeWrapEnvelope(command.ownerWrap);
      await tx.agencyCryptoOwnerKeyWrap.upsert({where:{agencyId_rootVersion_deviceId:{agencyId,rootVersion:root.version,deviceId:identity.deviceId}},
        create:{agencyId,rootVersion:root.version,deviceId:identity.deviceId,...envelope,createdByDeviceId:approver.device.id},
        update:{...envelope,revokedAt:null,createdByDeviceId:approver.device.id}});
      await revokeOwnerRootAccessForMember({db:tx,agencyId,userId:actor.userId,revokedAt:now});
    } else if (command.ownerWrap || command.actorProof || command.targetDeviceId || command.targetFingerprint) fail("OWNERSHIP_CRYPTO_PLAN_CHANGED","Unexpected encryption material for an uninitialized agency");
    // The unique DB index requires old-owner demotion first. Deferred minimum
    // validation observes only the final transaction state; no zero-owner state
    // is externally visible and every later failure rolls both updates back.
    const former = await tx.agencyMember.update({where:{id:actor.id},data:{role:"OPERATOR",roleKey:"chatter",assignedCreators:[],permissions:{},accessEpoch:{increment:1}}});
    const successor = await tx.agencyMember.update({where:{id:target.id},data:{role:"OWNER",roleKey:"owner",assignedCreators:"all",permissions:{},accessEpoch:{increment:1}}});
    await tx.refreshSession.updateMany({where:{agencyId,userId:{in:[actor.userId,target.userId]},revokedAt:null,expiresAt:{gt:now}},data:{revokedAt:now}});
    // Durable effects are in the same transaction as ownership and audit.
    await tx.$executeRawUnsafe(`INSERT INTO "DeviceCommand" ("id","deviceId","agencyId","command","payload","createdAt") SELECT md5($1||':'||d."id"),d."id",d."agencyId",'FORCE_LOGOUT','{"reason":"OWNERSHIP_TRANSFERRED"}'::jsonb,$2 FROM "WorkerDevice" d WHERE d."agencyId"=$3 AND d."userId" IN ($4,$5) ORDER BY d."id" ON CONFLICT ("id") DO NOTHING`,receiptId,now,agencyId,actor.userId,target.userId);
    const result = {ok:true,ownerMemberId:target.id,formerOwnerMemberId:actor.id,formerOwnerRole:"chatter",reloginRequired:true};
    await tx.auditLog.create({data:{id:receiptId,agencyId,actorUserId:userId,action:"team.ownership.transferred",targetType:"agency_member",targetId:target.id,metadata:{intentHash,result}}});
    return {body:result,replayed:false,members:[former,successor]};
  });
  for (const member of outcome.members) { try { publishDesktopControlEvent({type:"ACCESS_EPOCH_CHANGED",agencyId,targetUserId:member.userId,targetMemberId:member.id,accessEpoch:member.accessEpoch}); } catch (_) {} }
  return {...outcome.body,replayed:outcome.replayed};
}
module.exports = {transferSchema,ownershipTransferPlan,transferOwnership};
