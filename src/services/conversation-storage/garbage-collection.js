"use strict";

const c = require("./common");
const RECEIPT_BYTES = 4096;
const SCOPE_BATCH_SIZE = 8;

// The caller holds dialog_archive_scope FOR UPDATE. Keep deletion and accounted
// quota reclamation in that same transaction, including foreground page writes.
async function pruneDialogHistory(tx, scopeId, limit = 64) {
  const receipts = await c.rows(
    tx,
    "DELETE FROM dialog_archive_receipt WHERE (scope_id,command_id) IN (SELECT scope_id,command_id FROM dialog_archive_receipt WHERE scope_id=$1 AND expires_at<now() ORDER BY expires_at,command_id LIMIT $2) RETURNING command_id",
    scopeId,
    limit
  );
  const pages = await c.rows(
    tx,
    `DELETE FROM dialog_archive_page WHERE (scope_id,dialog_id,episode,cursor) IN (
      SELECT p.scope_id,p.dialog_id,p.episode,p.cursor FROM dialog_archive_page p
      JOIN dialog_archive_thread t USING(scope_id,dialog_id)
      WHERE p.scope_id=$1 AND p.created_at<now()-interval '2 days'
        AND NOT (p.episode IS NOT DISTINCT FROM t.collector_token AND COALESCE(t.state->>'scanHasMore','false')='true')
      ORDER BY p.created_at,p.dialog_id,p.episode,p.cursor LIMIT $2
    ) RETURNING cursor`,
    scopeId,
    limit
  );
  // The current unfinished episode remains a resume/cycle proof even when its
  // collector lease expires. Finished and replaced episodes follow retention.
  const freedBytes = (receipts.length + pages.length) * RECEIPT_BYTES;
  if (freedBytes) await c.exec(
    tx,
    "UPDATE dialog_archive_scope SET used_bytes=GREATEST(0,used_bytes-$2),status=CASE WHEN used_bytes-$2<quota_bytes-16384 THEN 'ACTIVE' ELSE status END WHERE scope_id=$1",
    scopeId,
    freedBytes
  );
  return { receipts: receipts.length, pages: pages.length, freedBytes };
}

// These cursors only enumerate derived housekeeping; they never acknowledge
// business work. Each process traverses the existing primary keys and starts a
// new pass at the end. Restarting can repeat a page safely. Empty, busy or failed
// scopes still advance the cursor, so no prefix can hide the remaining scopes.
async function collectConversationGarbage({ db, dialogs, analysis, cursors }) {
  const progress = {};
  let firstError;
  for (const [domain, table] of [["dialogs", "dialog_archive_scope"], ["crm", "crm_scope"]]) {
    const entry = progress[domain] = { visited: 0, skipped: 0, failed: 0, wrapped: false, after: cursors[domain] || "" };
    let scopes;
    try {
      scopes = await c.rows(
        db[domain],
        `SELECT scope_id,agency_id,platform_creator_id FROM ${table} WHERE scope_id>$1 ORDER BY scope_id LIMIT $2`,
        entry.after,
        SCOPE_BATCH_SIZE
      );
    } catch (error) {
      firstError ||= error;
      entry.failed++;
      continue;
    }
    for (const scope of scopes) {
      cursors[domain] = scope.scope_id;
      entry.visited++;
      const ctx = { scopeId: scope.scope_id, agencyId: scope.agency_id,
        platformCreatorId: scope.platform_creator_id, actorId: "conversation-gc" };
      try {
        const result = domain === "dialogs"
          ? await dialogs.prune(ctx, { skipLocked: true })
          : await analysis.collect(ctx, null, 32);
        if (result?.skipped) entry.skipped++;
      } catch (error) {
        firstError ||= error;
        entry.failed++;
      }
    }
    if (scopes.length < SCOPE_BATCH_SIZE) {
      cursors[domain] = "";
      entry.wrapped = true;
    }
    entry.after = cursors[domain];
  }
  return { progress, error: firstError };
}

module.exports = { pruneDialogHistory, collectConversationGarbage, SCOPE_BATCH_SIZE };
