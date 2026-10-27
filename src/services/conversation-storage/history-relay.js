"use strict";
const c = require("./common");
class HistoryRelay {
  constructor(dialogs, crm) {
    this.dialogs = dialogs;
    this.crm = crm;
  }
  async scope(ctx, limit = 32) {
    const records = await c.rows(
      this.dialogs.db,
      `SELECT o.*,s.epoch FROM dialog_archive_outbox o JOIN dialog_archive_scope s USING(scope_id)
      WHERE o.scope_id=$1 AND o.revision>o.acknowledged_revision AND o.retry_at<=now() ORDER BY o.retry_at,o.dialog_id LIMIT $2`,
      ctx.scopeId,
      limit
    );
    for (const row of records) {
      try {
        await this.crm.receiveHistory(ctx, {
          dialogId: row.dialog_id,
          epoch: row.epoch,
          revision: Number(row.revision),
          rewriteRevision: Number(row.rewrite_revision),
        });
        await c.exec(
          this.dialogs.db,
          "UPDATE dialog_archive_outbox SET acknowledged_revision=GREATEST(acknowledged_revision,$3),attempts=0 WHERE scope_id=$1 AND dialog_id=$2",
          ctx.scopeId,
          row.dialog_id,
          row.revision
        );
      } catch (error) {
        await c.exec(
          this.dialogs.db,
          "UPDATE dialog_archive_outbox SET attempts=LEAST(attempts+1,12),retry_at=now()+interval '30 seconds' WHERE scope_id=$1 AND dialog_id=$2",
          ctx.scopeId,
          row.dialog_id
        );
        throw error;
      }
    }
    return records.length;
  }
}
module.exports = { HistoryRelay };
