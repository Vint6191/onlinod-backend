"use strict";
const c = require("./common");
const { requireProductCreator, requireProductDevice } = require("../../middleware/product-access");
async function conversationContext(req, creatorId, db = require("../../prisma")) {
  const creator = await requireProductCreator(req, creatorId, { db }),
    deviceId = requireProductDevice(req, req.auth.deviceId);
  const identity = await db.creatorAccount.findFirst({
    where: { id: creator.id, agencyId: creator.agencyId, deletedAt: null },
    select: { remoteId: true, sessionState: { select: { platformUserId: true } } },
  });
  const remote = identity?.remoteId,
    session = identity?.sessionState?.platformUserId;
  c.check(!(remote && session && remote !== session), "DIALOG_CREATOR_IDENTITY_MISMATCH", 409);
  c.check(session || remote, "DIALOG_CREATOR_IDENTITY_NOT_READY", 409);
  const platformCreatorId = c.platformId(session || remote);
  if (req.body?.expectedPlatformCreatorId)
    c.check(req.body.expectedPlatformCreatorId === platformCreatorId, "DIALOG_CREATOR_IDENTITY_MISMATCH", 409);
  return {
    creatorId: creator.id,
    agencyId: creator.agencyId,
    platformCreatorId,
    scopeId: c.scopeId(creator.agencyId, platformCreatorId),
    deviceId,
    actorId: req.auth.membership?.id || req.auth.userId,
  };
}
module.exports = { conversationContext };
