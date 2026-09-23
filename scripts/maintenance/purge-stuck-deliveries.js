"use strict";
// Deliberate compatibility tombstone: do not connect to the database.
console.error(JSON.stringify({ ok: false, code: "LEGACY_DELIVERY_CLEANUP_RETIRED", error: "Legacy purge/dedupe is retired. Inspect Data Explorer and use the audited, creator-scoped terminal archive command. Active stuck work requires its domain recovery flow; dedupe is not archival." }));
process.exitCode = 1;
