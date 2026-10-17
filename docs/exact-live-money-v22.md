# Exact live money, release 163 V22 (verification of V21)

This release uses database contract `nod_current_v7_exact_live_money`. It is an
additive upgrade of V6. Historical migration files and dependency manifests are
unchanged. The database installer verifies the resulting catalog and migration
receipts. Do not run older backend writers after installing this contract.
V22 preserves the exact V7 schema and migration checksums delivered in V21.

## Additional V21 verification findings

Adversarial checks found three defects not covered by the previous green suite:

1. A blank transaction type passed the live money boundary, then failed the
   financial normalizer and rolled back a valid sibling payment in the same
   delivery. It now becomes unresolved money while valid siblings commit.
2. Live and scan category mappings disagreed for whitespace and subscription
   variants. A shared financial classification now supplies both paths, including
   full/delta generation preparation. NET totals were not the discrepant field.
3. Pending delivery acquired observation -> resolution request; cancellation in
   the resolver acquired request -> observation without the common money gate.
   Traces of executed SQL admit a cyclic wait schedule. The resolver now tries
   the creator money gate before the request row and yields if that gate is busy.

`scripts/audit/live-money-adversarial-proof.cjs` reproduces the first two against
actual SQL and exhaustively explores the row/advisory-lock ordering of the third.
It also exercises busy-owner yield and fair admission of 24 indebted creators in
eight agencies, with eight healthy controls and replay coalescing. On PGlite,
the busy result is injected; under the native PostgreSQL CI path, it holds the
money lock on a separate connection. The lock-order model is not a substitute
for executing native PostgreSQL concurrency tests.

## Data authority

The provider supplies monetary facts. The backend never infers NET by subtracting
a guessed commission and never uses a notification ID as a financial transaction
ID. A missing identity or NET is durable unresolved work, not a zero-value payment.

The Desktop normalizer hashes the normalized monetary revision as well as the
notification. A refund or corrected NET therefore reaches the durable outbox even
when the notification metadata has not changed. Identical retries still deduplicate.
The backend commits facts, money observations and delivery ACK in one transaction.

Capture samples advertise `moneyRevisionVersion: 1`. Older Desktop captures cannot
certify a complete monetary interval. On first upgrade, an existing outbox preserves
its journal and sequence authority, records one capture-loss revision and clears
the unsupported capture start. That loss requests the existing recovery protocol.
It is not repeated on subsequent opens. Old clients cannot claim resolution jobs.

## Ordinary operation and recovery

- A healthy creator consumes its live stream. Cache expiry, opening Home and a
  scheduler tick do not authorize a provider scan.
- Recovery is per creator, considering all eligible devices. An uncovered interval
  of at least one hour, or explicit capture loss, creates durable recovery work.
- Notifications and financial catchup reach the frozen known frontier and one
  additional verified page. Unordered subscriber/campaign lists retain their
  resumable traversal protocol; applying an ordered frontier to them is unsafe.
- The 700 ms provider gate is per creator across devices. Different creators do
  not share that spacing. This is distinct from shared database/worker capacity.
- An incomplete live money event may create a bounded resolution scan. This is
  event-driven repair, not periodic rescanning of healthy creators.

## Resolution of incomplete money

`CreatorMoneyResolutionRequest` coalesces work per creator. A bounded adoption
cursor also admits unresolved observations already present before V7. Normal
ingestion enqueues its request inside the delivery transaction. A local wake is
deferred until that transaction commits; durable work remains authoritative.

The resolver shares financial collector admission with all financial planners. It
respects active and paused financial jobs and requires a published baseline. It
selects the oldest eligible observation, waits briefly for source settlement and
creates a window no larger than one hour. For a known transaction already in the
ledger, the original transaction time determines the window. The job must carry
the target observation, window bounds, receipt protocol and Desktop capability.

Page receipts and provider chart totals prove the window before publication. An
identified target must actually be present in the verified run. An unexplained
active transaction missing from that window leaves the resolution unresolved;
the resolver does not manufacture a refund. Unidentifiable reversals, unsupported
currency and invalid event dates remain explicitly blocked. Six failed attempts
or an explicit cancellation stop automatic retries for that target. Paused work
remains paused. Another eligible target can proceed later.

Blocked observations retain their error and make freshness false. A verified full
reconciliation or an explicit operator decision is needed where the source lacks
enough identity; this release does not claim that every real provider payload has
been captured or can be resolved automatically.

## Publication

Full replacement uses a separate SNAPSHOT generation. Preparation is paged at
500 rows per transaction. Live revisions update the active and building snapshot;
an older scan cannot overwrite a newer monetary revision. Final publication swaps
the active pointer and proof in one transaction. A failed build leaves the previous
published Home readable.

Catchup and point resolution with an existing active generation use DELTA manifests.
They apply only the verified changed transactions to the active ledger and do not
copy the creator's entire history. Preparation is resumable. Exact facts can become
visible during preparation; the range is not declared complete until finalization.
If preparation is cancelled, already verified facts remain valid while unresolved
coverage remains unresolved. A delta cannot publish against a replaced base.

A frontier extends the existing verified upper bound without pretending that its
nominal lower request bound proves all history. A resolution changes only the
targeted debt; it does not advance the creator's global baseline, catchup frontier
or financial generation. A full scan cannot silently join disjoint proven ranges.

Previously published observation coverage is monotonic. Preparation of another
generation cannot steal or erase that coverage. Database triggers enforce this
rule as well as the V7 writer generation. Retention preserves published manifests
while pending observation links still depend on them, then compacts safely.

## Scheduling and locks

Publication and money resolution have a dedicated bounded executor in addition to
the existing maintenance path. It probes indexed durable work, not every creator.
The idle probe backs off to ten seconds; successful commits can wake it immediately.
Each local lane has one active loop. Domain work leases, ownership fences and
agency/partition fairness coordinate replicas. A stale claim cannot create a new
provider job or commit publication progress.

Financial resolution uses a nonblocking collector admission lock and does not wait
for a job row while holding that lock. Monetary writes use the creator's money lock.
No provider request runs while a publication transaction holds that money lock.
Native PostgreSQL concurrency, contention and sustained throughput remain a
separate release gate; single-connection tests cannot establish those properties.

## Home and cache

Home totals and curves read the same canonical money. Confirmed values remain
visible when a new observation is unresolved. A delivered healthy capture may
advance confirmed time only when no unresolved money or uncovered financial gap
remains; a heartbeat does not invent coverage.

Committed money and publication emit a coalesced agency-scoped `ANALYTICS_CHANGED`
hint without money or creator identifiers. It invalidates the backend's agency
cache and the Desktop's cached Home periods. Stale in-flight reads cannot refill a
new cache generation. Existing access/membership epochs isolate cache scopes.

Backend cache: 2 seconds, 512 entries per process. Desktop request cache: 10 seconds,
64 entries. Visible Home retains a fallback read at 10 seconds during pending work
or 30 seconds while idle. Those are backend reads, not provider scans. Push hints
and cache invalidation are process-local, so another backend replica relies on the
short TTL and fallback read; this is not guaranteed cross-replica instant push.

## Verification and deployment boundary

The release includes ordinary regression manifests and actual Prisma/SQL proofs
for delivery, recovery, bounded publication, cancellation, old writers, retention,
cache isolation, a 50,000-operation history and 1,000 creators. Local SQL proofs use
PGlite with one connection. They establish the exercised invariants, not production
capacity or native PostgreSQL lock scheduling.

`.github/workflows/bounded-live-sync.yml` runs the bounded and exact-money proofs
against isolated PostgreSQL 16 databases. It includes competing revisions and
creator isolation using a real connection pool. That workflow must succeed on
the release sources before a native concurrency claim is made. Sustained target
load and real provider message coverage also need staging evidence.

V7 adds indexes. Their build/lock duration on an existing large database has not
been measured here. Back up the database and measure the upgrade on a staging
copy before a production rollout. Do not reset the database. Rollback of code to
V6/V20 is not compatible with the new monetary writer fence.
