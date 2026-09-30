# Phase7: recovered applied history

The Render build at `ab357f5fc160aca8783a4312461c273059399f1c` exposed three
historical migration versions that differ from the current source. Their exact
original SQL was recovered from project archives; each SHA256 equals the
database checksum printed in that build. They are real SQL revisions, not
line-ending differences. Phase7's new strict history gate previously rejected
these existing histories even when their forward repairs had already completed.

`scripts/database/phase7-applied-history.json` records the three exact pairs,
source archive hashes, member paths, and six pinned repair dependencies:

| Applied migration | Existing forward repair |
| --- | --- |
| `20260614_traffic_core_v1` | `20260614_traffic_organic_orphans_v2` adds two attribution columns and their index. |
| `20260831223000_event_team_money_authority_cutover` | `20260901130000_event_team_money_authority_closure4`, `20260901140000_event_team_money_authority_closure5`, `20260901150000_event_team_money_authority_closure6` recover/classify retained manual attribution evidence and mark unresolved review cases. |
| `20260920123000_phase3_analytics_final_authority_cutover_v1` | `20260920191500_phase3_analytics_legacy_snapshot_phase_a_repair_v1` restores writable legacy relation contracts; `20260920192500_phase3_subscriber_publication_campaign_hotpath_forward_repair_v1` adds publication fields/backfill/indexes. |

The deployment wrapper accepts these versions only if the current source still
matches its pinned checksum, the recovered original file matches its recorded
checksum, and every listed repair has a finished, non-rolled-back database row
whose checksum matches the pinned repair source. Pending, failed, changed or
missing repairs do not qualify. Ordinary Prisma 5.22 LF/CRLF compatibility
continues to apply. This is recognition of a documented repaired history, not
an assertion that old and current scripts have identical effects.

The event `PHASE7_VERIFIED_HISTORICAL_MIGRATIONS` reports every recognized
revision and its repair dependencies. All other mismatches still stop the
build. No database history row is edited and no migration is marked applied by
this code. The archived SQL under `scripts/database/phase7-applied-history/`
is evidence only: it is never staged or executed. All 270 canonical migration
files, the eight preflight and four postflight hooks, role checks and the
separate destructive contract gate remain unchanged. Prisma may still report
its own warning about the known historical modifications.

The old analytics revision performed destructive operations. Its later repair
restores table contracts, not deleted historical rows. Likewise, the money
repairs use surviving evidence and cannot reconstruct evidence that was lost.
This change does not claim to audit or recover past production data; it makes
the Phase7 history check understand the existing, explicitly repaired history.

Validation: the focused Node suite covers exact recovered bytes, the three
Render hashes, all six repair dependencies, source/evidence tampering, unknown
hash rejection and preservation of deployment/contract gates. A separate
disposable PGlite replay executes original and canonical histories with their
existing forward repairs and checks actual Phase7 physical contracts. It is
not a production deployment, a concurrency test or a Windows runtime test.
