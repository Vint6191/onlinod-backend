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
npm ci && npm run prisma:migrate
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
SNAPSHOT_ENCRYPTION_KEY=32-byte-base64-server-key
EMAIL_FROM=Onlinod <onboarding@resend.dev>
```

Verification and reset mail use the durable encrypted `AuthMailOutbox`. Production requires a stable 32-byte base64 `SNAPSHOT_ENCRYPTION_KEY`, plus `RESEND_API_KEY` and a verified `EMAIL_FROM` for delivery. With mail unconfigured, delivery stays pending until token expiry; public responses never disclose verification codes or reset links. Do not rotate the server encryption key while encrypted pending mail still needs delivery.

The cumulative 6D+6E candidate and its rollout/acceptance limits are described in `docs/PHASE6_DE_DURABLE_EFFECTS_RESOURCE_ADMISSION.txt`. Apply Backend and Desktop as one coordinated version, using the normal migration deploy pipeline; old unkeyed management routes return 410.

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


## Current creator session authority

Desktop connects through the authenticated Session Broker. The Backend stores a
revisioned canonical CreatorSessionState with a CLIENT_E2E_V1 opaque envelope.
Only the authorized Desktop device decrypts creator session and proxy secrets.
Worker-device telemetry is not crypto identity or permission authority.

Changes to Team, billing, account security and management use durable command
receipts and current actor checks at commit. A lost HTTP response must be
recovered with the same command identity. Retired unkeyed routes return 410.

## Runtime and verification

Use Node.js 22 and the committed lockfile (`npm ci`). Run `npm test` for service
regressions and `npm run test:auth-boundary` for authentication boundaries.
Desktop has its own build and test gates; update the two projects together.
Native PostgreSQL and Windows/Electron acceptance require their named proof
runners and environments; Node-only unit tests do not replace those gates.

## Database deployment and retirement

`npm run prisma:migrate` runs the guarded Phase 7 deployment pipeline. Preserve
all historical migrations and existing database receipts. Review
`docs/PHASE7_LEGACY_STORAGE_RETIREMENT.txt` before using any contract/retirement
option. An ordinary source update does not authorize destructive retirement.

A release manifest describes one exact source pair. Generate a new manifest only
for its documented retirement workflow; old release manifests are kept with
historical checkpoints, not shipped as evidence for later source changes.

The old root delivery cleanup commands remain explicit non-mutating tombstones.
For current cleanup and recovery use the audited domain operations documented in
`docs/PHASE6_DE_DURABLE_EFFECTS_RESOURCE_ADMISSION.txt`.
