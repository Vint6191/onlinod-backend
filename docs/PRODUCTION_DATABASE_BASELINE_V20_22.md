# V20.22 clean production database baseline

This is for a **brand-new public production database only**.

Do not squash, delete, rename or edit the existing `prisma/migrations/` history on a development/staging database that has already applied it. Prisma tracks migration identity/checksums.

## Goal

After V20.22 cleanup, public production should be initialized from the final `prisma/schema.prisma`, where old session architecture is structurally absent.

## Generate the baseline

Run in a normal development/CI checkout after `npm install`:

```bash
node scripts/database/generate-production-baseline-v20-22.js
```

The script invokes Prisma's schema diff from an empty database and writes:

```text
artifacts/database-baseline-v20-22/migration.sql
```

Review that SQL before use. The script never connects to or mutates a database.

## New database procedure

1. Provision an empty PostgreSQL database.
2. Generate and review the baseline SQL.
3. Apply the baseline SQL once to the empty database.
4. Mark that baseline as applied using your release/deployment migration procedure before introducing later incremental migrations.
5. From that point onward, keep every new migration normally.

The exact `migrate resolve` identifier should be chosen when the baseline is promoted into the production migration directory. Do not run `migrate resolve` against an existing database merely to make history look cleaner.

## Existing development/staging databases

Keep the existing migration history and run:

```bash
npm run prisma:migrate
```

The V20.22 enum-finalization migration fails closed if any `SERVER_V1` session/proxy rows remain.
