# NOD Backend

Backend API, NOD public website and the existing platform administration UI.

## Public website

The supplied NOD design is served directly by this Backend. No separate frontend hosting or build command is required.

- `/`: public homepage; `/pricing`, `/download`, `/questions`, `/help`.
- `/register`: creates a real User, Agency, owner membership and encrypted verification mail in one transaction.
- `/verify-email`: explicit confirmation by link or six-digit code; opening a GET link does not consume it.
- `/login`, `/account`: browser sessions and current account/agency information.
- `/forgot-password`, `/reset-password`: one-time password recovery that revokes previous sessions.
- `/invite/:token`: registration or existing-account acceptance with the invitation’s actual agency, role and creator scope.
- `/admin`: existing administration UI.

The website and Desktop share the existing account, membership, session and password authorities. Browser credentials are HttpOnly, SameSite=Lax cookies scoped to `/api/web`; HTTPS makes them Secure. Browser mutation endpoints require the same origin and an explicit website-client header. Native `/api/auth` token responses retain their existing contract.

Pricing comes from the active commercial policy through `/api/site/pricing`. The calculator is an estimate; wallet and creator subscription operations remain in Desktop. Support forms and their widget send email requests with attachments and an explicit provider receipt; replies arrive by email.

## Render

Build command:

```bash
npm install && npm run prisma:migrate
```

Start command:

```bash
npm start
```

Keep the existing `DATABASE_URL`, `JWT_SECRET` and stable encryption key. This website update adds no database migration and requires no database cleanup or replacement.

Set these in Render Environment (values below are examples):

```env
NODE_ENV=production
DATABASE_URL=postgresql://...
JWT_SECRET=your-existing-secret
PUBLIC_BASE_URL=https://onlinod-backend.onrender.com
APP_URL=https://onlinod-backend.onrender.com
ACCESS_TOKEN_TTL=15m
REFRESH_TOKEN_TTL_DAYS=30
RESEND_API_KEY=your-resend-key
SNAPSHOT_ENCRYPTION_KEY=your-existing-32-byte-base64-key
EMAIL_FROM=NOD <mail@your-verified-domain.example>
SUPPORT_EMAIL=your-support-inbox@example.com
```

`APP_URL` and `PUBLIC_BASE_URL` must be the same public origin serving this site. An HTTPS origin without a path is required; local HTTP loopback is supported for development. Browser registration and resend/reset requests return `AUTH_EMAIL_UNAVAILABLE` when the key, mail API or public origin is unconfigured. A provider rejection after registration leaves the account awaiting confirmation and permits another mail request.

Verification and reset mail use the encrypted durable `AuthMailOutbox` and the existing Backend retry worker. Do not replace a working `SNAPSHOT_ENCRYPTION_KEY`: pending payloads need the same key. If a new installation has no key, generate one locally with `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"` and save the output only in Render Environment.

Use a verified sender domain in Resend for mail to other users. The default `onboarding@resend.dev` sender can only send to the email belonging to the Resend account. See [Resend’s sender-domain instructions](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain). Configuration availability is not proof of inbox delivery; inspect the provider logs and `AuthMailOutbox` delivery status if mail is missing.

## Published installers and legal links

The Download page reads metadata from `/api/site/config`. For each published platform, set:

```env
NOD_WINDOWS_DOWNLOAD_URL=https://your-release-host.example/NOD-Setup.exe
NOD_WINDOWS_VERSION=your-published-version
NOD_WINDOWS_SHA256=64-lowercase-hex-characters
NOD_WINDOWS_SIZE_BYTES=123456789
NOD_WINDOWS_MINIMUM_OS=your-tested-system
NOD_WINDOWS_ARCHITECTURE=your-build-architecture
```

Use the same suffixes with `NOD_MACOS_` for macOS. URL, version and SHA-256 are mandatory; other fields are optional. Only HTTPS URLs without embedded credentials are accepted. Until a real release is configured, the page shows that the build is unavailable. This source update does not fabricate or host installer binaries.

Optional `NOD_TERMS_URL` and `NOD_PRIVACY_URL` connect the approved published documents. Unconfigured documents show an honest availability notice. Server credentials are never returned by the public configuration API.

## Current creator session authority

Desktop connects through the authenticated Session Broker. The Backend stores a
revisioned canonical CreatorSessionState with a CLIENT_E2E_V1 opaque envelope.
Only the authorized Desktop device decrypts creator session and proxy secrets.
Worker-device telemetry is not crypto identity or permission authority.

Changes to Team, billing, account security and management use durable command
receipts and current actor checks at commit. A lost HTTP response must be
recovered with the same command identity. Retired unkeyed routes return 410.

## Runtime and verification

Use Node.js 22 and the committed lockfile (`npm ci`). Run `npm run test:all` for
regressions and `npm run test:auth-boundary` for authentication boundaries.
Desktop has its own build and test gates; update the two projects together.
Native PostgreSQL and Windows/Electron acceptance require their named proof
runners and environments; Node-only unit tests do not replace those gates.

## Database deployment and retirement

`npm run prisma:migrate` installs the current baseline into an empty PostgreSQL database using the public schema.
It includes the schema, business triggers, functions, queues, indexes and initial
controls. Repeating the command on the same current installation is safe.
By default, old migration receipts or nonempty unbaselined databases are rejected
without changing data.

For the existing disposable pre-153 test database, including free Render/Neon
plans with only a Build Command, use this once:

```bash
npm install && npm run prisma:migrate -- --reset-legacy-test-database
```

**This deletes the old public schema and all its test data**, then installs the
current baseline into the same database. DATABASE_URL and the Start Command stay
the same. No new database, SQL console, shell access or paid plan is required.
After a successful deploy, restore the ordinary Build Command above. Repeating
the reset option against a current installation preserves its data. The option
only accepts migration history older than the fixed first current baseline;
it refuses current/failed/changed baseline receipts and later migration history.
The source checksum is verified before database writes. History inspection and
schema replacement are in one locked transaction; a failed schema replacement
rolls back, and an interruption after replacement can resume on the empty database.

The installer gives Prisma an isolated copy of the verified current migration.
Retired directories left by a source overlay are never applied and cannot block
installation. Windows CRLF checkouts produce the same canonical migration receipt.
The installer never deletes repository files. Run the deletion-only BAT in each
project root to remove retired source files, then commit those deletions to Git.
`prisma db push` is not an installation path: it cannot install the required business SQL.

`/health` checks the connection. `/ready` and startup verify the applied baseline,
business functions, triggers, constraints, indexes and current control rows. These
checks are read-only and never perform activation, backfill or archive operations.

The reproducible clean-install SQL proof is `npm run test:database`; see
`TESTING141.md` for its isolated runtime and the complete source verification order.
`npm run test:database-overlay` additionally verifies mixed migration directories,
repeat installation, CRLF files, default rejection of an existing old database,
explicit test reset and preservation of current data when the option is repeated.

`npm run test:admin-diagnostics` checks the full bounded diagnostic pass against
the current schema, including restart of an obsolete cached cursor, current
delivery states and pending bump cleanup. CRM profiles/tags currently live on
Desktop and are explicitly outside server diagnostic coverage. Sending and later
deleting the same message are different operations, not duplicate sends.
`npm run test:server-startup` launches the real server on a disposable database,
observes normal background timers through the first recurring sweep, checks HTTP
health/readiness, stops cleanly and restarts with the same data. Both proofs use
ONLINOD_SQL_PROOF_RUNTIME and never connect to the application's DATABASE_URL.
