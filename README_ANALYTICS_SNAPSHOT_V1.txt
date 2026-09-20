# Analytics Snapshot v1 — RETIRED (Phase 3)

This file is kept only as a historical marker. The v1 snapshot authority is no longer a runtime contract.

Current Phase 3 behavior:
- `POST /api/analytics/snapshots/report` is retired; the authenticated analytics compatibility route returns `410 GONE`.
- Home / Stats / Billing read canonical relational facts and current collection state. They do not read `AnalyticsSnapshot`, `CreatorCampaignsSnapshot`, or `CreatorEarningsSnapshot` as authority.
- Electron remains the OnlyFans collector/executor, while Backend owns durable relational analytics state and authority rules.
- The three legacy snapshot tables are intentionally preserved only during the Phase-A rolling-deploy / rollback window so an older backend revision can still finish an in-flight legacy write safely.
- Destructive table removal is a separate Phase-B migration and must not occur until old revisions are drained and an explicit backup/preflight is verified.

See `docs/PHASE3_ANALYTICS_LEGACY_SNAPSHOT_RETIREMENT.md`.
