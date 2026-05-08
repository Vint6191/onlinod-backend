
# Presence Orchestration v1

Added backend support for centralized Online Users / presence.

## New backend pieces

- `src/routes/presence.js`
- `src/services/presence-service.js`
- `src/services/presence-scheduler.js`
- Prisma models:
  - `CreatorPresenceSnapshot`
  - `CreatorPresenceUser`
- Migration:
  - `prisma/migrations/20260508120000_presence_orchestration_v1/migration.sql`

## New API

```txt
GET  /api/presence/creators/:creatorId?status=visible&limit=500
POST /api/presence/creators/:creatorId/events
POST /api/presence/creators/:creatorId/snapshot
POST /api/presence/creators/:creatorId/refresh
GET  /api/presence/agency/summary
```

## Job orchestration

Backend scheduler creates `refresh_online_presence` jobs roughly every 12 minutes for READY creators that have active worker-device bindings.
Existing `/api/jobs/claim` gives that job to one eligible machine.
Existing `/api/jobs/:id/report` now detects `refresh_online_presence` and writes the result into presence tables.

## Env knobs

```txt
ONLINOD_PRESENCE_REFRESH_MS=720000      # default 12 min
ONLINOD_PRESENCE_SWEEP_MS=60000         # scheduler checks every 1 min
ONLINOD_PRESENCE_ACTIVE_DEVICE_MS=300000 # device must be active in last 5 min
```

## Electron patches

See `_electron_presence_orchestration_patches/`.
The Electron online-users module should now:

1. Show backend snapshot first.
2. Push WS normalized events to backend.
3. Let backend schedule API refresh jobs.
4. Execute `refresh_online_presence` jobs when claimed.
