Onlinod backend merged package

What was merged:
- Existing onlinod-backend-main code kept as base.
- Admin v2 backend routes are already present in src/routes/admin.js and src/routes/impersonate.js.
- Admin v2 frontend added under public/admin/.
- src/server.js catch-all patched so /admin* and /admin-login return public/admin/index.html.
- Existing auth core / workspace context / devices / creator billing files are preserved.
- Did NOT add old migration 20260428000000_admin_v2 because this repo already has 20260501120000_admin_v2_electron_auth with the same Admin v2 DB changes; adding the older migration now would be unsafe for migration order.

Deploy commands on Render:
Build Command:
  npm install && npm run prisma:migrate
Start Command:
  npm start

Local sanity checks run here:
- node --check for all src/**/*.js, public/**/*.js, scripts/**/*.js: OK

After deploy:
- /admin-login
- /admin
- /api/admin/dashboard
- /api/admin/system/health

