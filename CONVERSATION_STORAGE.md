# Dialogs and CRM beta storage

The existing `DATABASE_URL` remains the product authority for membership, access,
jobs and financial facts. Add two **different PostgreSQL databases**, not two
schemas in that database:

```text
DIALOGS_DATABASE_URL=postgresql://USER:PASSWORD@HOST/onlinod_dialogs?sslmode=require
CRM_DATABASE_URL=postgresql://USER:PASSWORD@HOST/onlinod_crm?sslmode=require
CONVERSATION_BRANCH_MAX_BYTES=850000000
```

Keep these URLs on the backend. Desktop uses the authenticated product API and
never receives database credentials. With Neon, use pooled connection URLs for
runtime. The database names must differ. Each new database must be empty for its
first installation; the installer rejects the main database and mixed domains.

Run `npm run prisma:migrate` before starting this backend. It installs the
existing product contract first, then the two conversation schemas when their
URLs are configured. `npm run conversation:migrate` installs just these two
schemas. Installation is transactional, repeatable and checksum checked; it does
not reset or import an existing database. Install both Desktop180 and Backend180.

## What is saved

- Dialogs DB: platform creator/fan/author/message IDs as strings, message facts,
  scan cursors, collection coverage, receipts, bounded projection handoffs and
  history revisions. Identity is `(agency, onlyfans, platformCreatorId)`; an
  internal creator ID is an authorized binding to that identity.
- CRM DB: fan profiles, individual manual notes, field revisions, creator
  persona, analysis work, leases, compact checkpoints, results and receipts.
  Inference still executes through the existing desktop AI runtime.
- PC: browser sessions, device keys, runtime execution and bounded pending-send
  SQLite journal in `desktop-cache/conversation-runtime/pending.sqlite`. It is
  not an accepted-history or CRM database. Successful sends discard the body
  and retain a small replay identity. Unconfirmed writes survive a restart.

Existing local history and persona files are left intact. There is **no
automatic history or CRM import**. A server archive starts its own collection
window at activation. Initial scanning stops at that date; it does not fetch
all prior history just because the server is empty. Exact targeted message
reconciliation can collect one older message when an existing operation needs
that fact. A collection window is never advertised as complete lifetime history.

The model quota is **200,000,000 accounted bytes**, including conservative message,
index/metadata allowances, bounded receipts and thread overhead. A page either
commits fully with its cursor or rolls back fully. At the limit, collection pauses;
history reads and CRM remain available. Expired receipts are reclaimed in bounded
chunks. Existing messages are not automatically deleted to make room.

Accounted bytes are not `pg_database_size`. Before admitting new growing work,
the backend separately checks the physical size of connectable databases in its
PostgreSQL branch. The default guard is 850,000,000 bytes. This cannot see other
Neon branches/projects; their usage and the provider's total storage limit must
be budgeted separately. Physical PostgreSQL files may stay allocated after a
delete. Do not raise the guard beyond available provider capacity.

## Failure and recovery

Message commits and their history notifications are one Dialogs transaction.
A bounded, leased relay delivers coalesced revisions to CRM. It acknowledges
only after the CRM transaction commits. CRM failure does not roll back accepted
messages. No database transaction stays open across the other database's request.

A temporarily unreachable Dialogs or CRM database does not block the core HTTP
listener. Readiness is logged per domain and the relay retries after 30 seconds.
Shutdown drains both HTTP requests and background operations before disconnecting
any of the three databases.
Invalid or reused database URLs still fail configuration checks.

Every scanner state update includes the archive epoch and expected scan episode.
A previous device/episode cannot write an error, pause or completion over a new
owner. A pause or completion releases the collection lease immediately.

Accepted commands can replay their stored receipt after the 24-hour new-command
window. An expired command with no receipt is rejected, never re-executed.
A later failed journal entry does not change an earlier successful commit.

Manual changes use field revisions. Concurrent additions create separate notes;
they never replace another person's whole note array. AI cannot overwrite
protected manual fields. Analysis completion, accepted input, CRM changes and
the replay receipt commit together in CRM. History revision fences reject edited
input, and the UI compares an accepted result against the current archive revision.

After restoring CRM independently, run `npm run conversation:reconcile`. This
recreates notification obligations in indexed pages without copying history or
overwriting manual profiles. Restore manual CRM data from its own backup.
When restoring Dialogs independently, stop Desktop and backend workers during
the restore. Before restarting them, run
`npm run conversation:reconcile -- --dialogs-restored`. This rotates archive epochs
and requeues notifications, so old AI inputs and scan pages cannot be accepted
against rewound revision numbers. It does not delete or reimport message bodies.

An ambiguous desktop response is retried with the same command ID. New commands
expire after 24 hours; accepted receipts can still be read during their retention
window. Expired commands with no receipt and permanently rejected commands stay
locally as failed pending data and are not silently resubmitted as new commands. Correct the
reported conflict or capacity issue and resubmit the intended edit. An outbox
capacity error means the operation was not admitted; existing history is intact.

## Verification

`npm run audit:conversation` uses two local fixture PostgreSQL databases when
`ONLINOD_DIALOGS_TEST_DATABASE_URL` and `ONLINOD_CRM_TEST_DATABASE_URL` are set.
It accepts only localhost databases whose names begin `onlinod_test_`.
The dedicated GitHub workflow creates these databases and runs the proof.
For isolated local SQL checks, `ONLINOD_SQL_PROOF_RUNTIME` may point to a runtime
with `@electric-sql/pglite`; this does not prove multi-connection load behavior.

Desktop: build shared packages and Electron, then run
`node --test apps/desktop/scripts/conversation-storage180.test.mjs` from its root.
The test checks the actual SQLite journal worker, scanner ownership, collection
boundary and retry outcomes. For a cross-project loss/restart proof, run
`node apps/desktop/scripts/conversation-storage-integration180.mjs /path/to/backend`
with the same isolated SQL runtime settings. It executes the real client, cache,
journal worker, scanner and backend repositories with an injected lost response. Integration with real OnlyFans sessions, Windows Electron and your
Neon/Render deployment must be checked on the installed pair.

The server's AI validator/default profile are reproducibly generated from the
current Desktop contract. After changing it, run from Desktop:
`node apps/desktop/scripts/build-server-crm-contract.mjs <backend-directory>`.
CI/review can append `--check` to detect drift without changing files.
