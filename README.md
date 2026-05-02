# Onlinod Backend v3

Backend API + built-in debug Web Console for Onlinod.

## What is included

- Web Console served at `/`
- Email registration
- Email verification by link or 6-digit code
- Resend verification email
- Login only after email verified
- Access token + refresh token
- Refresh session
- Logout
- Forgot password
- Reset password
- Agency workspace
- Creator/model account CRUD
- Avatar upload
- Prisma migration for Neon/Postgres
- Render-ready setup

## Render

Build command:

```bash
npm install && npm run prisma:migrate
```

Start command:

```bash
npm start
```

Environment variables:

```env
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_SECRET=long-random-secret
PUBLIC_BASE_URL=https://onlinod-backend.onrender.com
APP_URL=https://onlinod-backend.onrender.com
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
RESEND_API_KEY=
EMAIL_FROM=Onlinod <onboarding@resend.dev>
```

For first tests, `RESEND_API_KEY` may be empty. Then `/api/auth/register` returns `devVerificationUrl` and `devVerificationCode` in the Web Console debug panel.

## Console

Open:

```txt
https://onlinod-backend.onrender.com
```

Use it to test:

- register
- verify email by code
- login
- load current user
- add/list creator accounts
- forgot/reset password


## v5 Creator Analytics WebApp

The web app now uses:

- Login / registration / verify email
- Home dashboard shell
- Creator Analytics module adapted from Electron HQ
- `+ Add Account` modal backed by `POST /api/creators`
- Creator list backed by `GET /api/creators`
- Electron-only actions are intentionally shown as toast placeholders

Open:

```txt
https://onlinod-backend.onrender.com
```

Flow:

```txt
Register → Verify Email → Login → Creator Analytics → + Add Account
```


## v6 Creator Connect + encrypted snapshots

New backend flow:

```txt
Web + Add Account
→ POST /api/creator-connect/start
→ backend creates draft creator + connect session
→ browser opens onlinod://connect?token=...
→ Electron claims token later
→ Electron logs into OF, collects cookies snapshot
→ Electron POST /api/creator-connect/:id/complete
→ backend encrypts snapshot and marks creator READY
```

New env variable:

```env
SNAPSHOT_ENCRYPTION_KEY=
```

Generate:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

New API:

```txt
POST /api/creator-connect/start
POST /api/creator-connect/claim
GET  /api/creator-connect/:id/status
POST /api/creator-connect/:id/complete
POST /api/creator-connect/:id/simulate-complete
GET  /api/creators/:creatorId/access-snapshots
GET  /api/access-snapshots/:id/payload
POST /api/access-snapshots/:id/revoke
```

For web-only testing, use the `Dev: simulate complete` button in the Add Account modal.


## v6.1 public connect token flow

Electron does not need to log into Onlinod for the first connect flow.

New public endpoints:

```txt
POST /api/creator-connect/claim-public
GET  /api/creator-connect/status-public?token=...
POST /api/creator-connect/complete-public
POST /api/creator-connect/simulate-complete-public
```

These endpoints are authorized by the short-lived one-time connect token generated from the authenticated Web Console `POST /api/creator-connect/start`.

Electron flow:

```txt
onlinod://connect?token=...
→ POST /api/creator-connect/claim-public { token, deviceId, ... }
→ open returned partition + loginUrl
→ collect OF cookies/users.me
→ POST /api/creator-connect/complete-public { token, deviceId, snapshot }
```
