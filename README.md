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
