# Onlinod Backend Core v1 + Analytics Snapshot v1 — merged patch

This archive is already merged in the correct order:

1. Backend Core v1
2. Analytics Snapshot v1 override

Copy the contents of this archive into the backend repository root.

## Important

Analytics Snapshot v1 overrides these Backend Core v1 files:
- src/server.js
- src/services/home-summary-service.js
- src/services/team-analytics-service.js

That is intentional. The snapshot version changes the architecture so backend stores/serves precomputed snapshots from Electron instead of recalculating heavy analytics from raw telemetry on every request.

## After copying

```bash
npm install
npx prisma validate
npm run prisma:migrate
npm run start
```

## Smoke test after deploy

From Electron DevTools after login:

```js
await window.desktopAPI.backend.request("/api/modules/state")
await window.desktopAPI.backend.request("/api/analytics/snapshots/latest?scope=home&range=24h")
await window.desktopAPI.backend.request("/api/home/summary?range=24h")
await window.desktopAPI.backend.request("/api/team/analytics/overview?range=24h")
await window.desktopAPI.backend.request("/api/team/analytics/members?range=24h")
```

## Electron still needed

For real Home/Team numbers, install the Electron Snapshot Reporter patch separately, because backend only stores and returns snapshots. Electron calculates and reports them.
