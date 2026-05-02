# Onlinod backend — Admin v2 + Team v2 + Orchestration v1 merged

This archive is based on the previously merged Admin v2 + Team v2 backend and adds Orchestration v1.

Included:
- `src/routes/stats.js`
- `src/routes/jobs.js`
- `prisma/migrations/20260504000000_orchestration_v1/migration.sql`
- schema models:
  - `CreatorEarningsSnapshot`
  - `CreatorCampaignsSnapshot`
  - `JobInstance`
- server mounts:
  - `/api/stats`
  - `/api/jobs`

Compatibility fixes:
- Mounted stats/jobs under existing `authRequired`.
- Patched stats/jobs route user access to support our auth shape: `req.auth.userId`.
- Kept Admin v2, Team v2, Auth Core, Devices heartbeat, Workspace context intact.
- Electron orchestration patch source files are included under `_electron_orchestration_v1_patches/` for reference.

Deploy:
```bash
npm install && npm run prisma:migrate
npm start
```

After deploy:
- `/api/stats/creators/:creatorId/earnings?range=7d`
- `/api/stats/creators/:creatorId/refresh`
- `/api/jobs/claim`
- `/api/jobs/pending`
