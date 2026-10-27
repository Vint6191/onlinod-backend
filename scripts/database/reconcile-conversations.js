"use strict";
const c = require("../../src/services/conversation-storage/common");
const { getDatabases, ready } = require("../../src/services/conversation-storage/databases");
// Rebuild delivery obligations after restoring CRM separately. Never reads,
// imports, deletes or rewrites message bodies or manual CRM fields.
async function reconcile(db, { dialogsRestored = false } = {}) {
  let afterScope = "",
    total = 0;
  for (;;) {
    const scopes = await c.rows(
      db,
      "SELECT scope_id FROM dialog_archive_scope WHERE scope_id>$1 ORDER BY scope_id LIMIT 32",
      afterScope
    );
    if (!scopes.length) break;
    for (const scope of scopes) {
      // Run with Desktop/backend stopped after restoring Dialogs. Rotating the
      // archive epoch invalidates old captured inputs even if revisions were rewound.
      if (dialogsRestored)
        await c.exec(db, "UPDATE dialog_archive_scope SET epoch=$2 WHERE scope_id=$1", scope.scope_id, c.randomUUID());
      let afterDialog = "";
      for (;;) {
        const page = await c.rows(
          db,
          "SELECT dialog_id FROM dialog_archive_outbox WHERE scope_id=$1 AND dialog_id>$2 ORDER BY dialog_id LIMIT 128",
          scope.scope_id,
          afterDialog
        );
        if (!page.length) break;
        await c.transaction(db, async (tx) => {
          await c.one(tx, "SELECT scope_id FROM dialog_archive_scope WHERE scope_id=$1 FOR UPDATE", scope.scope_id);
          await c.exec(
            tx,
            "UPDATE dialog_archive_outbox SET acknowledged_revision=0,retry_at=now(),attempts=0 WHERE scope_id=$1 AND dialog_id=ANY($2::text[])",
            scope.scope_id,
            page.map((r) => r.dialog_id)
          );
          await c.exec(
            tx,
            "UPDATE dialog_archive_scope SET relay_pending=true,relay_next_at=now() WHERE scope_id=$1",
            scope.scope_id
          );
        });
        total += page.length;
        afterDialog = page.at(-1).dialog_id;
      }
      afterScope = scope.scope_id;
    }
  }
  return total;
}
async function main() {
  const db = getDatabases();
  try {
    await ready(db.dialogs, "dialogs");
    await ready(db.crm, "crm");
    console.log(
      `History notifications scheduled: ${await reconcile(db.dialogs, { dialogsRestored: process.argv.includes("--dialogs-restored") })}`
    );
  } finally {
    await Promise.all([db.dialogs.$disconnect(), db.crm.$disconnect()]);
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.code || error.message);
    process.exitCode = 1;
  });
module.exports = { reconcile };
