# Orchestration v1 — historical note, current Phase 3 authority

This root note used to list `CreatorEarningsSnapshot` and `CreatorCampaignsSnapshot` as orchestration schema authorities. That statement is retired.

Current authority:
- `JobInstance` remains part of orchestration.
- Earnings, Campaigns, Home and Stats are backed by canonical relational ledgers / current collection state, not snapshot tables.
- Legacy `CreatorEarningsSnapshot`, `CreatorCampaignsSnapshot`, and `AnalyticsSnapshot` physical tables are retained only for the Phase-A rolling-deploy compatibility window and are not current runtime authority.
- `/api/analytics/snapshots/report` is retired.

For legacy-table removal rules see `docs/PHASE3_ANALYTICS_LEGACY_SNAPSHOT_RETIREMENT.md`.
