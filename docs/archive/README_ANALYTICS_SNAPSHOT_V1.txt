# Analytics Snapshot Reporting v1 - Backend

This turns backend analytics into orchestration/storage, not heavy compute.

## New primary flow
Electron captures local team-stats events and computes compact summaries on the agency machine.
Then it reports snapshots to backend:

POST /api/analytics/snapshots/report

Backend stores latest AnalyticsSnapshot rows and serves Home / Team Analytics from those snapshots.
Raw telemetry ingest remains available for limited/debug use, but Home/Team do not need to scan raw events on every request.

## New endpoint
- POST /api/analytics/snapshots/report
- GET /api/analytics/snapshots/latest?scope=home&range=24h

## Snapshot scopes
- home
- team_overview
- team_members
- team_alerts
- team_flags

## Updated behavior
- /api/home/summary reads latest home snapshot for messages/workers/health.
- /api/team/analytics/* reads latest team snapshots.
- Revenue still comes from CreatorEarningsSnapshot, which is already produced by Electron jobs-runner and stored on backend.

## Deploy
No new schema migration is required if Backend Core v1 is already applied, because AnalyticsSnapshot already exists.

```bash
npm install
npx prisma validate
npm run prisma:migrate
git add -A
git commit -m "Use analytics snapshots for home and team summaries"
git push
```
