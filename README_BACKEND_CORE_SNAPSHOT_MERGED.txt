# Backend Core + Analytics Snapshot — historical compatibility note

The old Analytics Snapshot architecture described by earlier revisions is RETIRED in Phase 3.

Do not install an Electron Snapshot Reporter patch and do not use `/api/analytics/snapshots/report` or `/api/analytics/snapshots/latest` as current analytics authority. Current Home / Stats / Billing use canonical relational facts and collection-state contracts.

The physical legacy snapshot tables are temporarily preserved only for safe rolling deployment with an older backend revision. They are not read by the current revision and are not a fallback authority.

Destructive cleanup belongs to the separate Phase-B retirement procedure after revision drain + verified backup. See `docs/PHASE3_ANALYTICS_LEGACY_SNAPSHOT_RETIREMENT.md`.
