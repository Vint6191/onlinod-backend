"use strict";
const { adminError, deliveryArchiveSchema } = require("./admin-command-contract");
const { executeAdminCommand } = require("./admin-commit-authority-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { archiveAutomationDeliveryBatch } = require("./automation-history-service");
async function archiveAdminDeliveries({ db, actor, commandId, creatorId, payload }) {
  const normalized = deliveryArchiveSchema.parse(payload);
  return executeAdminCommand({ db, actor, commandId, action: "data.delivery.archive", targetId: creatorId, payload: normalized,
    work: async ({ tx, payload: input }) => {
      if (new Date(input.olderThan) > await dbAuthorityNow({ db: tx })) throw adminError("ADMIN_ARCHIVE_CUTOFF_INVALID", "Archive cutoff must be in the past", 400);
      const selected = await tx.automationDelivery.findMany({ where: { id: { in: input.items.map(item => item.id) }, agencyId: input.agencyId, creatorId }, take: 100 });
      if (selected.length !== input.items.length) throw adminError("ADMIN_ARCHIVE_SELECTION_CHANGED", "Selection is missing or outside this creator", 409);
      const revisions = new Map(input.items.map(item => [item.id, new Date(item.expectedUpdatedAt).getTime()]));
      if (selected.some(row => row.updatedAt.getTime() !== revisions.get(row.id))) throw adminError("ADMIN_ARCHIVE_SELECTION_CHANGED", "Selection changed; reload before archiving", 409);
      const result = await archiveAutomationDeliveryBatch({ tx, rows: selected, olderThan: new Date(input.olderThan), strict: true });
      return { agencyId: input.agencyId, body: { ok: true, ...result }, audit: { creatorId, olderThan: input.olderThan, items: input.items, ...result } };
    },
  });
}
module.exports = { archiveAdminDeliveries };
