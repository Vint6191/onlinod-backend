"use strict";
const { randomUUID } = require("node:crypto");
const { encryptSnapshot, decryptSnapshot } = require("./snapshot-crypto");
const { digest } = require("./team-command-contract");
const { withAuthorizationUserLock } = require("./authorization-session-authority-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { sendMail } = require("./email-service");

async function enqueueAuthMail(tx, { userId, authTokenId, kind, payload, expiresAt }) {
  if (Buffer.byteLength(JSON.stringify(payload)) > 32 * 1024) throw new Error("AUTH_MAIL_PAYLOAD_LIMIT");
  const id = randomUUID(),
    envelope = encryptSnapshot(payload);
  await tx.$executeRawUnsafe(
    'INSERT INTO "AuthMailOutbox" ("id","userId","authTokenId","kind","payload","fingerprint","expiresAt") VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)',
    id,
    userId,
    authTokenId,
    kind,
    JSON.stringify(envelope),
    digest(payload),
    expiresAt
  );
  return id;
}
async function deliverAuthMail({ db, id, send = sendMail }) {
  const [candidate] = await db.$queryRawUnsafe('SELECT "userId" FROM "AuthMailOutbox" WHERE "id"=$1', id);
  if (!candidate) return { ok: false, code: "AUTH_MAIL_MISSING" };
  const startedMono = performance.now();
  const claimed = await withAuthorizationUserLock({
    db,
    userId: candidate.userId,
    work: async (tx) => {
      const [row] = await tx.$queryRawUnsafe(
        'SELECT m.*, t."usedAt", t."expiresAt" AS "tokenExpiresAt", u."disabledAt" FROM "AuthMailOutbox" m JOIN "AuthToken" t ON t."id"=m."authTokenId" JOIN "User" u ON u."id"=m."userId" WHERE m."id"=$1 FOR UPDATE OF m',
        id
      );
      if (!row || ["SENT", "FAILED", "EXPIRED"].includes(row.status))
        return { result: { ok: row?.status === "SENT", code: row?.status || "MISSING" } };
      const now = await dbAuthorityNow({ db: tx });
      if (row.usedAt || row.disabledAt || row.expiresAt <= now || row.tokenExpiresAt <= now) {
        await tx.$executeRawUnsafe(
          'UPDATE "AuthMailOutbox" SET "status"=\'EXPIRED\',"payload"=NULL,"leaseId"=NULL,"leaseUntil"=NULL,"updatedAt"=$2 WHERE "id"=$1',
          id,
          now
        );
        return { result: { ok: false, code: "AUTH_MAIL_EXPIRED" } };
      }
      if (row.leaseUntil > now || row.nextAttemptAt > now) return { result: { ok: false, code: "AUTH_MAIL_PENDING" } };
      const leaseId = randomUUID();
      // A 30-minute token lifetime is strictly inside Resend's documented 24-hour
      // idempotency window. The exact encrypted wire payload survives every retry.
      await tx.$executeRawUnsafe(
        'UPDATE "AuthMailOutbox" SET "status"=\'COMMITTING\',"attempt"="attempt"+1,"leaseId"=$2,"leaseUntil"=$3,"updatedAt"=$4 WHERE "id"=$1',
        id,
        leaseId,
        new Date(now.getTime() + 60_000),
        now
      );
      return {
        row,
        leaseId,
        validForMs: Math.min(
          45_000,
          row.expiresAt.getTime() - now.getTime(),
          row.tokenExpiresAt.getTime() - now.getTime()
        ),
      };
    },
  });
  if (claimed.result) return claimed.result;
  let result;
  try {
    const payload = decryptSnapshot(claimed.row.payload);
    if (digest(payload) !== claimed.row.fingerprint) throw new Error("AUTH_MAIL_PAYLOAD_CORRUPT");
    if (performance.now() - startedMono >= claimed.validForMs)
      result = { ok: false, code: "AUTH_MAIL_ADMISSION_EXPIRED", outcome: "not_started" };
    else result = await send(payload, { idempotencyKey: `onlinod-auth-mail/${id}` });
  } catch (_) {
    result = { ok: false, code: "AUTH_MAIL_PAYLOAD_OR_TRANSPORT_FAILED", outcome: "unknown" };
  }
  await withAuthorizationUserLock({
    db,
    userId: candidate.userId,
    work: async (tx) => {
      const now = await dbAuthorityNow({ db: tx });
      const status = result.ok
        ? "SENT"
        : result.outcome === "rejected"
          ? "FAILED"
          : result.outcome === "not_started"
            ? "PENDING"
            : "UNKNOWN";
      const retryAt = new Date(now.getTime() + Math.min(5 * 60_000, 15_000 * 2 ** Math.min(claimed.row.attempt, 5)));
      await tx.$executeRawUnsafe(
        'UPDATE "AuthMailOutbox" SET "status"=$3,"providerId"=$4,"lastCode"=$5,"leaseId"=NULL,"leaseUntil"=NULL,"nextAttemptAt"=$6,"updatedAt"=$7,"payload"=CASE WHEN $3 IN (\'SENT\',\'FAILED\') THEN NULL ELSE "payload" END WHERE "id"=$1 AND "leaseId"=$2',
        id,
        claimed.leaseId,
        status,
        result.providerId || null,
        String(result.code || "SENT").slice(0, 100),
        retryAt,
        now
      );
    },
  });
  return result;
}
function startAuthMailWorker({ db, intervalMs = 10_000, send }) {
  let stopped = false,
    flight = null;
  const drain = () => {
    if (stopped || flight) return;
    flight = (async () => {
      const rows = await db.$queryRawUnsafe(
        'SELECT "id" FROM "AuthMailOutbox" WHERE "status" IN (\'PENDING\',\'UNKNOWN\',\'COMMITTING\') AND "nextAttemptAt"<=CURRENT_TIMESTAMP AND ("leaseUntil" IS NULL OR "leaseUntil"<=CURRENT_TIMESTAMP) ORDER BY "nextAttemptAt","id" LIMIT 4'
      );
      for (const row of rows) {
        if (stopped) break;
        await deliverAuthMail({ db, id: row.id, send });
      }
    })()
      .catch(() => {
        /* Rows remain recoverable; never log credentials or provider body. */
      })
      .finally(() => {
        flight = null;
      });
  };
  const timer = setInterval(drain, intervalMs);
  timer.unref?.();
  drain();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await flight;
  };
}
module.exports = { enqueueAuthMail, deliverAuthMail, startAuthMailWorker };
