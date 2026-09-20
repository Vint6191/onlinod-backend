# Phase 3 analytics legacy snapshot retirement

## Current deployment contract: Phase A

The Phase 3 application revision has retired all runtime authority for these legacy relations:

- `AnalyticsSnapshot`
- `CreatorCampaignsSnapshot`
- `CreatorEarningsSnapshot`

They MUST remain physical writable tables during Phase A. Render applies migrations before the new application revision owns all traffic; an older in-flight backend can still execute the legacy `analyticsSnapshot.upsert()` contract. Replacing a table with a read-only view or dropping it in the Phase-A migration therefore creates a rolling-deploy failure window.

The current revision does not read these tables as fallback authority. Their presence is compatibility-only.

## Phase-A preflight

Before deployment, run:

```bash
npm run audit:phase3-legacy-snapshot-preflight
```

The preflight is read-only. It fails if any legacy relation is missing or is not a physical table and records current row counts. Phase A is safe to deploy only when all three relations are physical tables (`relkind = r`).

## Phase B: destructive purge — separate future migration only

Do not append destructive statements to the Phase-A migration. A Phase-B migration may be created only after all of the following are recorded outside the database migration itself:

1. The previous backend revision is fully drained and cannot receive traffic or run background jobs.
2. The rollback window is closed, or the rollback artifact no longer depends on legacy snapshot writes.
3. A backup of all three tables has been created and restore-tested (for example, a `pg_dump` scoped to the three relations).
4. Pre-purge row counts are recorded and compared with the backup manifest.
5. The current revision has been re-audited to prove there are no readers, writers, Prisma models, raw SQL references, or documented public contracts that depend on these tables.
6. The destructive migration is reviewed as Phase B and deployed separately from the authority cutover.

Only after those gates may Phase B drop the three physical relations. No zero-row compatibility views are required once old revisions are truly drained.
