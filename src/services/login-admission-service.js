"use strict";
const { createHash } = require("node:crypto");
const { isIP } = require("node:net");
const { runDbTransaction } = require("./db-transaction-service");
const WINDOW_SECONDS = 15 * 60;
const transactionOptions = { timeout: 2500, maxWait: 1000, deadlineMs: 3500, lockTimeoutMs: 1000, statementTimeoutMs: 2000, maxAttempts: 1 };
const cleanup = new WeakSet();
const lastCleanupWarning = new WeakMap();
function limit(value, fallback) { const n = Number(value ?? fallback); if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error("AUTH_RATE_LIMIT_CONFIG_INVALID"); return n; }
function ipScope(value) {
  const raw = typeof value === "string" ? value.slice(0, 128).split("%")[0] : "";
  if (isIP(raw) === 4) return raw;
  if (isIP(raw) !== 6) return "unknown";
  const canonical = new URL(`http://[${raw}]/`).hostname.slice(1, -1);
  const sides = canonical.split("::"), left = sides[0] ? sides[0].split(":") : [], right = sides[1] ? sides[1].split(":") : [];
  const words = sides.length === 2 ? [...left, ...Array(8-left.length-right.length).fill("0"), ...right] : left;
  const n = words.map(word => parseInt(word, 16));
  if (n.slice(0, 5).every(v => v === 0) && n[5] === 65535) return [n[6] >> 8, n[6] & 255, n[7] >> 8, n[7] & 255].join(".");
  return n.slice(0, 4).map(v => v.toString(16)).join(":") + "::/64";
}
function admissionKeys({ surface, ip, email }) {
  if (!["member", "admin"].includes(surface)) throw new Error("LOGIN_SURFACE_INVALID");
  const normalizedEmail = typeof email === "string" && email.length <= 254 ? email.trim().toLowerCase() : "invalid";
  const hash = value => createHash("sha256").update(value).digest("hex");
  return [{ id: hash(`login-v1:ip:${ipScope(ip)}`), limit: limit(process.env.AUTH_RATE_LIMIT_PER_15_MIN, 10) },
    { id: hash(`login-v1:account:${surface}:${normalizedEmail}`), limit: limit(process.env.AUTH_ACCOUNT_RATE_LIMIT_PER_15_MIN, 10) }].sort((a,b) => a.id.localeCompare(b.id));
}

// One bounded, coalesced cleanup root, independent from credential admission.
// SKIP LOCKED avoids waiting on another login's bucket; no timer/large in-memory key map.
function scheduleCleanup(db) {
  if (cleanup.has(db)) return;
  cleanup.add(db);
  void runDbTransaction(db, tx => tx.$executeRawUnsafe(`WITH expired AS (
    SELECT "id" FROM "LoginAdmissionBucket" WHERE "expiresAt" < clock_timestamp()
    ORDER BY "expiresAt", "id" LIMIT 128 FOR UPDATE SKIP LOCKED
  ) DELETE FROM "LoginAdmissionBucket" b USING expired e WHERE b."id"=e."id"`), transactionOptions)
    .catch(() => {
      const now = Date.now();
      if (now - (lastCleanupWarning.get(db) || 0) >= 60_000) {
        lastCleanupWarning.set(db, now);
        console.error("[auth] login admission cleanup unavailable");
      }
    }).finally(() => cleanup.delete(db));
}
async function reserveLoginAttempt({ db, ...input }) {
  const keys = admissionKeys(input);
  let admitted = false;
  try {
    const result = await runDbTransaction(db, async tx => {
      const reservations = [];
      for (const key of keys) {
        const rows = await tx.$queryRawUnsafe(`INSERT INTO "LoginAdmissionBucket" AS b ("id","windowStartedAt","expiresAt","attempts")
          VALUES ($1,clock_timestamp(),clock_timestamp()+($3 * interval '1 second'),1)
          ON CONFLICT ("id") DO UPDATE SET
            "attempts"=CASE WHEN b."expiresAt"<=clock_timestamp() THEN 1 ELSE b."attempts"+1 END,
            "windowStartedAt"=CASE WHEN b."expiresAt"<=clock_timestamp() THEN clock_timestamp() ELSE b."windowStartedAt" END,
            "expiresAt"=CASE WHEN b."expiresAt"<=clock_timestamp() THEN clock_timestamp()+($3 * interval '1 second') ELSE b."expiresAt" END
          WHERE b."expiresAt"<=clock_timestamp() OR b."attempts"<$2
          RETURNING "id","windowStartedAt"`, key.id, key.limit, WINDOW_SECONDS);
        if (!rows.length) {
          const retry = await tx.$queryRawUnsafe('SELECT GREATEST(1,CEIL(EXTRACT(EPOCH FROM ("expiresAt"-clock_timestamp()))))::int AS seconds FROM "LoginAdmissionBucket" WHERE "id"=$1', key.id);
          throw Object.assign(new Error("Too many sign-in attempts. Please try again later."), { code: "LOGIN_RATE_LIMITED", status: 429, retryAfter: Number(retry[0]?.seconds) || WINDOW_SECONDS });
        }
        reservations.push(rows[0]);
      }
      return reservations;
    }, transactionOptions);
    admitted = true;
    return result;
  } finally { if (admitted) scheduleCleanup(db); }
}
async function releaseSuccessfulAttempt({ db, reservations }) {
  // Match the exact DB-issued window. A late success must not refund a newer window.
  return runDbTransaction(db, async tx => {
    for (const entry of reservations) await tx.$executeRawUnsafe('UPDATE "LoginAdmissionBucket" SET "attempts"=GREATEST(0,"attempts"-1) WHERE "id"=$1 AND "windowStartedAt"=$2::timestamptz', entry.id, entry.windowStartedAt);
  }, transactionOptions);
}
module.exports = { reserveLoginAttempt, releaseSuccessfulAttempt, admissionKeys, ipScope, WINDOW_SECONDS };
