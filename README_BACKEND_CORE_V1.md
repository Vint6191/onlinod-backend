# Onlinod Backend Core v1

This package keeps the current working backend and adds the missing shared foundation for all renderer modules.

## New source-of-truth layer

Electron remains the OF runtime/collector/executor. Backend becomes the shared source of truth for module dashboards.

Added backend routes:

- `POST /api/telemetry/events/ingest` — Electron team-stats JSONL events → backend `TeamActivityEvent`.
- `GET /api/home/summary?range=24h|7d|30d|90d|180d|365d|ytd|prev_year|all` — Home dashboard payload.
- `GET /api/team/analytics/overview?range=...`
- `GET /api/team/analytics/members?range=...`
- `GET /api/team/analytics/alerts?range=...`
- `GET /api/team/analytics/flags?range=...`
- `GET /api/audit?module=team&limit=50` — unified audit feed.
- `GET /api/modules/state` / `PATCH /api/modules/:moduleKey` — module registry/settings.
- `GET/PATCH /api/settings/workspace`, `GET /api/settings/runtime`.
- `GET/PUT /api/vault/unsorted/:creatorId` — only unsorted vault sync, not full vault.
- `GET /api/message-library/state` and basic template/group CRUD.
- `GET /api/automation/state` and basic rule CRUD.

## Schema added

- `DeviceCreatorBinding`
- `TeamActivityEvent`
- `AnalyticsSnapshot`
- `WorkspaceSetting`
- `ModuleSetting`
- `MessageTemplateGroup`
- `MessageTemplate`
- `MessageTemplateUsageEvent`
- `AutomationRule`
- `AutomationRun`
- `AutomationLog`
- `VaultUnsortedSnapshot`

Migration:

```bash
npm install
npm run prisma:migrate
```

## Smoke tests after deploy

From Electron devtools after login:

```js
await window.desktopAPI.backend.request('/api/modules/state')
await window.desktopAPI.backend.request('/api/home/summary?range=24h')
await window.desktopAPI.backend.request('/api/team/analytics/overview?range=7d')
await window.desktopAPI.backend.request('/api/team/analytics/members?range=7d')
```

Telemetry ingest test:

```js
await window.desktopAPI.backend.request('/api/telemetry/events/ingest', {
  method: 'POST',
  body: {
    deviceId: 'debug-device',
    events: [{ localId: 'debug-1', ts: Date.now(), type: 'message_sent', viewerId: 'debug', accountId: 'debug', fanId: 'fan_1' }]
  }
})
```

Then:

```js
await window.desktopAPI.backend.request('/api/home/summary?range=24h')
await window.desktopAPI.backend.request('/api/team/analytics/overview?range=24h')
```

## Important boundaries

- Renderer modules must not be final source of truth.
- Electron collects raw facts and executes jobs.
- Backend stores, aggregates, checks permissions, and feeds UI summaries.
- Full Vault stays local/Electron for now. Only unsorted snapshots are added to backend.
