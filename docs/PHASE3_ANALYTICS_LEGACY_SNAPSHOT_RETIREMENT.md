# Phase 3 analytics legacy snapshot retirement

## Current deployment contract: Phase A

The Phase 3 application revision has retired all runtime authority for these legacy relations:

- `AnalyticsSnapshot`
- `CreatorCampaignsSnapshot`
- `CreatorEarningsSnapshot`

They are compatibility-only. The current revision does not read them as fallback authority.

During a normal Phase-A rollout they remain physical writable tables so an older in-flight backend revision can still complete a legacy Prisma upsert safely while Render is applying migrations and switching revisions.

## Production repair bridge for already-applied tombstone views

An earlier cutover revision replaced these tables with zero-row read-only views. Some production databases may therefore already have `relkind = v` for all three relations even though the current source migration has been corrected to preserve physical tables.

An already-applied Prisma migration is not re-run, so Phase A includes a forward-only repair migration:

`20260920191500_phase3_analytics_legacy_snapshot_phase_a_repair_v1`

The deploy sequence is deliberately:

1. read-only legacy snapshot preflight;
2. other online preflights;
3. `prisma migrate deploy`;
4. legacy snapshot postflight;
5. remaining index preflights.

The preflight accepts only two known states:

- a physical table with the legacy writer columns; or
- the exact zero-row Phase-3 tombstone view created by the earlier cutover (known comment, required columns, zero rows).

The second state is reported as `repairRequired: true`. Missing relations, unexpected relation kinds, populated views, or unknown views fail closed.

The forward-only repair migration replaces only the known zero-row tombstone views and recreates the legacy physical table contracts, including the conflict-key indexes required by the old Prisma upserts. If a relation is already a physical table, it is preserved.

The postflight must then prove that all three relations are physical tables and that their required writer conflict indexes exist. If that proof fails, the build fails before the new application revision starts.

The prior destructive cutover already discarded any historical rows that had existed in these snapshot tables. The repair restores write compatibility; it does not reconstruct deleted legacy snapshot history. That loss is acceptable to the current Phase-3 runtime because these relations are no longer authority, but it must not be confused with data restoration.

## Phase B: destructive purge — separate future migration only

Do not append destructive statements to the Phase-A migration or repair migration. A Phase-B migration may be created only after all of the following are recorded outside the database migration itself:

1. The previous backend revision is fully drained and cannot receive traffic or run background jobs.
2. The rollback window is closed, or the rollback artifact no longer depends on legacy snapshot writes.
3. A backup of all three compatibility tables has been created and restore-tested.
4. Pre-purge row counts are recorded and compared with the backup manifest.
5. The current revision has been re-audited to prove there are no readers, writers, Prisma models, raw SQL references, or documented public contracts that depend on these tables.
6. The destructive migration is reviewed as Phase B and deployed separately from the authority cutover.

Only after those gates may Phase B drop the three physical relations.
