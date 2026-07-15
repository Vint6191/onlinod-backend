"use strict";

const { audit, sanitizeAuditMetadata } = require("./audit-service");

function compactControl(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return null;
  return {
    workspaceEnabled: snapshot.effective?.workspaceEnabled === true,
    creatorEnabled: snapshot.effective?.creatorEnabled === true,
    followBackEnabled: snapshot.effective?.followBackEnabled === true,
    bumpsEnabled: snapshot.effective?.bumpsEnabled === true,
    likesEnabled: snapshot.effective?.likesEnabled === true,
    followEnabled: snapshot.effective?.followEnabled === true,
    sfsEnabled: snapshot.effective?.sfsEnabled === true,
  };
}

async function automationAudit({
  agencyId,
  actorUserId = null,
  creatorId = null,
  moduleKey = null,
  action,
  targetType = null,
  targetId = null,
  before = null,
  after = null,
  details = null,
  db,
}) {
  return audit({
    agencyId,
    actorUserId,
    action: `automation.${String(action || "event")}`,
    targetType: targetType || moduleKey || "automation",
    targetId: targetId || creatorId || null,
    metadata: sanitizeAuditMetadata({
      creatorId,
      moduleKey,
      before,
      after,
      details,
    }),
    db,
  });
}

module.exports = {
  automationAudit,
  compactControl,
};
