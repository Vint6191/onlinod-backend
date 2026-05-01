const prisma = require("../prisma");

async function audit({ agencyId, actorUserId = null, action, targetType = null, targetId = null, metadata = null }) {
  try {
    if (!agencyId || !action) return null;

    return await prisma.auditLog.create({
      data: {
        agencyId,
        actorUserId,
        action,
        targetType,
        targetId,
        metadata,
      },
    });
  } catch (err) {
    console.warn("[audit] failed:", err?.message || err);
    return null;
  }
}

module.exports = {
  audit,
};
