"use strict";

const prisma = require("../prisma");

async function readAuditFeed({ agencyId, moduleKey = null, limit = 50, cursor = null }) {
  const take = Math.min(100, Math.max(1, Number(limit) || 50));
  const where = { agencyId };
  if (moduleKey) {
    where.OR = [
      { action: { startsWith: `${moduleKey}.` } },
      { targetType: moduleKey },
    ];
  }
  if (cursor) where.createdAt = { lt: new Date(cursor) };

  const rows = await prisma.auditLog.findMany({
    where,
    include: { actor: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take,
  });

  return rows.map((row) => ({
    id: row.id,
    action: row.action,
    targetType: row.targetType,
    targetId: row.targetId,
    metadata: row.metadata || {},
    createdAt: row.createdAt,
    actor: row.actor ? { id: row.actor.id, email: row.actor.email, name: row.actor.name } : null,
  }));
}

module.exports = { readAuditFeed };
