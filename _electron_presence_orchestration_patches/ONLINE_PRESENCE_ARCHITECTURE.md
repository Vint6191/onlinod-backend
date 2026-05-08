
# Online Presence Orchestration v1

Backend is now the source of shared presence truth for the studio.

Flow:

1. Local Electron page opens creator account.
2. Local websocket-listener emits normalized presence events.
3. Electron sends those events to:
   `POST /api/presence/creators/:creatorId/events`
4. Backend stores shared `CreatorPresenceUser` rows.
5. Presence scheduler creates `refresh_online_presence` jobs every ~12 minutes per creator with an active worker device binding.
6. Only one free worker machine claims the job through existing `/api/jobs/claim`.
7. Worker does the OF API online snapshot.
8. Worker reports job result to `/api/jobs/:id/report`.
9. Backend persists the API snapshot and marks absent previously-online users offline.
10. All clients read the shared snapshot with:
    `GET /api/presence/creators/:creatorId`

No every-client API hammering.
