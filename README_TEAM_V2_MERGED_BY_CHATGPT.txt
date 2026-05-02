# Onlinod backend — Admin v2 + Team v2 merged

This archive is based on `onlinod-backend-admin-v2-merged-ready.zip` and has Team v2 backend merged in.

## Included backend changes

- Added Team v2 migration:
  - `prisma/migrations/20260502000000_team_v2/migration.sql`
- Patched `prisma/schema.prisma`:
  - Team fields on `AgencyMember`
  - `AgencyCustomRole`
  - `AgencyRoleOverride`
  - `AgencySubPermissionOverride`
  - `AgencyInvitation`
  - relations on `Agency` and `User`
- Added:
  - `src/middleware/team-permissions.js`
  - `src/routes/team.js`
  - `src/routes/invitations.js`
- Patched:
  - `src/server.js`
  - `src/middleware/auth.js`
  - `src/routes/auth.js`
  - `src/routes/workspace.js`

## Important compatibility fixes applied

- Team routes are mounted as:
  - `/api/team` with `authRequired`
  - `/api/invitations` with public preview and auth-protected claim
- `authRequired` now also sets `req.user`, so Team v2 routes can use the old expected shape.
- Team membership checks ignore `deletedAt` members.
- Workspace context now includes Team v2 membership fields and scopes creators for non-owner/non-manager members using `assignedCreators`.
- New registered owners get `roleKey: "owner"` and `assignedCreators: "all"`.

## Electron renderer patches

This backend archive also includes Team v2 renderer patch files under:

`_electron_team_v2_renderer_patches/`

Do not copy these into backend runtime. They are there so we can wire Electron next.

Files I need from Electron to merge Team v2 renderer cleanly:

- `renderer/index.html`
- `renderer/core/app-start.js`
- `renderer/core/backend-session.js`
- `electron/preload.js`
- `electron/backend-auth-client.js`
- `modules/team-analytics/renderer/team-analytics-state.js`
- `modules/team-analytics/renderer/team-analytics-events.js`
- `modules/team-analytics/renderer/index.js`

Likely bridge work:
- `desktopAPI.backend.request(...)`
- `desktopAPI.backend.getAccessToken(...)`

The Team API wrapper expects a generic authenticated request bridge. If it is not in Electron yet, we need to add it.
