Merged backend pack for Onlinod.

Includes:
- Admin v2 backend routes from provided files.
- Impersonation route mounted at /api/impersonate.
- Prisma schema updated for admin v2 soft-delete/device commands/impersonation tokens.
- New migration: prisma/migrations/20260501120000_admin_v2_electron_auth/migration.sql
- Electron auth compatibility:
  - POST /api/auth/login accepts rememberDevice/deviceId/client and returns token expiries.
  - POST /api/auth/refresh accepts deviceId/client and returns token expiries.
  - GET /api/workspace/context added.
  - POST /api/devices/heartbeat added.
- Creators list/read/update/delete now ignores soft-deleted creators; delete soft-deletes by default.

Deploy:
1. Copy these files over repo.
2. git add . && git commit -m "Merge admin v2 and Electron auth backend"
3. git push
4. Render deploy with build command using Prisma 5, e.g. npm install && npx prisma@5.22.0 migrate deploy

Smoke tests after deploy:
- GET /health
- POST /api/auth/login
- POST /api/auth/refresh
- GET /api/workspace/context with Bearer token
- POST /api/devices/heartbeat with Bearer token
- GET /api/admin/dashboard with admin Bearer token
