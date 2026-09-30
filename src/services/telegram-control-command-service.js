"use strict";
const { z } = require("zod");
const { digest } = require("./team-command-contract");
const { runRootCommit } = require("./db-commit-kernel");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { acquireAuthorizationUserLock } = require("./authorization-session-authority-service");
const { assertManagementCommitAuthority, lockAgencyLifecycle } = require("./management-commit-authority-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { audit } = require("./audit-service");
const { encryptTelegramCredentials, decryptTelegramCredentials } = require("./telegram-mtproto-credentials");
const {
  fail,
  ACCOUNT_LIMIT,
  credentialRevision,
  accountRevision,
  publicAccount,
  readReminderState,
  assertAuthorizationIdle,
} = require("./telegram-control-state");
const ACTIONS = [
  "telegram.create",
  "telegram.reminders",
  "telegram.retire",
  "telegram.forceRetire",
  "telegram.session",
];
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const origin = { deviceId: z.string().min(1).max(160), originAuthorizationSessionId: z.string().min(1).max(220) };
const minutes = z.number().int().min(1).max(525600),
  text = z.string().max(2000);
const policy = z
  .object({
    content: z.object({ enabled: z.boolean(), firstAfterMinutes: minutes, repeatEveryMinutes: minutes, text }).strict(),
    call: z.object({ enabled: z.boolean(), offsetsMinutes: z.array(minutes).min(1).max(12), text }).strict(),
    physical: z.object({ enabled: z.boolean(), repeatEveryMinutes: minutes, text }).strict(),
  })
  .strict();
const shapes = {
  "telegram.create": z
    .object({
      ...origin,
      apiId: z.number().int().min(1).max(2147483647),
      apiHash: z.string().regex(/^[a-fA-F0-9]{32}$/),
    })
    .strict(),
  "telegram.reminders": z.object({ ...origin, reminders: policy, expectedRevision: revision }).strict(),
  "telegram.retire": z.object({ ...origin, expectedRevision: revision }).strict(),
  "telegram.forceRetire": z
    .object({
      ...origin,
      expectedRevision: revision,
      reason: z.string().trim().min(1).max(1000),
      acknowledgeLostObservations: z.literal(true),
    })
    .strict(),
  "telegram.session": z
    .object({
      ...origin,
      expectedCredentialRevision: revision,
      session: z
        .string()
        .min(1)
        .max(262144)
        .refine((s) => s.trim() === s),
    })
    .strict(),
};
const envelope = z
  .object({
    commandId: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    action: z.enum(ACTIONS),
    targetId: z.string().max(180),
    payload: z.record(z.unknown()),
  })
  .strict();
function parse(input, cancel = false) {
  const c = envelope.parse(input);
  if (Buffer.byteLength(JSON.stringify(c.payload)) > 272 * 1024)
    throw fail("TELEGRAM_CONTROL_PAYLOAD_LIMIT", "Telegram action is too large", 413);
  const fingerprint = digest(["telegram-control-v1", c.commandId, c.action, c.targetId, c.payload]);
  if (!cancel) {
    const targeted = !["telegram.create", "telegram.reminders"].includes(c.action);
    if (targeted ? !c.targetId : c.targetId !== "")
      throw fail("TELEGRAM_CONTROL_TARGET_INVALID", "Invalid Telegram target", 400);
    return { ...c, payload: shapes[c.action].parse(c.payload), fingerprint };
  }
  return { ...c, fingerprint };
}
async function actor(tx, { agencyId, userId, actorMember, deviceId, authorizationSessionId }) {
  if (
    !agencyId ||
    !userId ||
    actorMember?.userId !== userId ||
    !actorMember?.id ||
    !deviceId ||
    !authorizationSessionId
  )
    throw fail("TELEGRAM_CONTROL_ACTOR_REQUIRED", "Sign in with an updated Desktop", 401);
  await acquireAuthorizationUserLock(tx, { userId });
  // Match account security/login lock order, without a SHARE -> UPDATE upgrade.
  await tx.$queryRawUnsafe('SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE', userId);
  const authority = await assertManagementCommitAuthority({
    tx,
    agencyId,
    actorMember,
    agencyAlreadyLocked: true,
    ownerOrAdmin: true,
  });
  const now = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
  const live = await tx.refreshSession.findFirst({
    where: { userId, agencyId, deviceId, authorizationSessionId, revokedAt: null, expiresAt: { gt: now } },
    select: { id: true },
  });
  if (!live) throw fail("SESSION_REVOKED", "This sign-in is no longer active", 401);
  return { now, member: authority.member };
}
async function lockedAccount(tx, agencyId, id) {
  const [row] = await tx.$queryRawUnsafe(
    'SELECT * FROM "AgencyTelegramMtprotoAccount" WHERE "id"=$1 AND "agencyId"=$2 FOR UPDATE',
    id,
    agencyId
  );
  return row || null;
}
async function currentResult(tx, agencyId, c, reference, now) {
  if (c.action === "telegram.reminders") return { ok: true, ...(await readReminderState(tx, agencyId)) };
  const row = await tx.agencyTelegramMtprotoAccount.findFirst({ where: { id: reference.accountId, agencyId } });
  const account = publicAccount(row, now);
  if (["telegram.retire", "telegram.forceRetire"].includes(c.action))
    return {
      ok: true,
      accountId: reference.accountId,
      account,
      retired: !row,
      lifecycleState: row ? "RETIRING" : "RETIRED",
      drainRequired: account?.drainRequired || false,
      drainCompleted: !row || account.drainCompleted,
      retirementRequestedAt: account?.retirementRequestedAt || null,
      ...(c.action === "telegram.forceRetire" ? { forced: true } : {}),
    };
  return {
    ok: true,
    accountId: reference.accountId,
    account,
    ...(c.action === "telegram.session" ? { sessionStored: true } : {}),
  };
}
async function executeTelegramControlCommand(args) {
  const { db, agencyId, userId, input, cancel = false } = args,
    c = parse(input, cancel);
  const id = "telegram_control_v1_" + digest([agencyId, userId, c.commandId]);
  return runRootCommit(
    db,
    async ({ tx }) => {
      await lockAgencyLifecycle({ tx, agencyId });
      await lockDbAdvisoryXact({ db: tx, key: id });
      const { now, member } = await actor(tx, args);
      const [prior] = await tx.$queryRawUnsafe('SELECT * FROM "ManagementCommandReceipt" WHERE "id"=$1', id);
      if (prior && prior.fingerprint !== c.fingerprint)
        throw fail("TELEGRAM_CONTROL_COMMAND_CONFLICT", "Command ID belongs to another Telegram action");
      const store = (status, reference) =>
        tx.$executeRawUnsafe(
          'INSERT INTO "ManagementCommandReceipt" ("id","agencyId","userId","action","targetId","fingerprint","status","reference") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
          id,
          agencyId,
          userId,
          c.action,
          c.targetId,
          c.fingerprint,
          status,
          JSON.stringify(reference)
        );
      if (cancel) {
        if (!prior) await store("ABANDONED", {});
        return {
          ok: true,
          commandId: c.commandId,
          alreadyCommitted: prior?.status === "COMMITTED",
          abandoned: !prior || prior.status === "ABANDONED",
        };
      }
      if (prior?.status === "ABANDONED")
        throw fail("TELEGRAM_CONTROL_COMMAND_ABANDONED", "This Telegram action was cancelled");
      if (prior)
        return {
          ok: true,
          commandId: c.commandId,
          action: c.action,
          replayed: true,
          result: await currentResult(tx, agencyId, c, prior.reference, now),
        };
      if (
        c.payload.deviceId !== args.deviceId ||
        c.payload.originAuthorizationSessionId !== args.authorizationSessionId
      )
        throw fail(
          "TELEGRAM_CONTROL_ORIGIN_CHANGED",
          "This pending action belongs to an earlier sign-in; cancel it before starting another"
        );
      const settings = require("./settings-service"),
        p = c.payload;
      let reference = {};
      if (c.action === "telegram.create") {
        await lockDbAdvisoryXact({ db: tx, key: `telegram-accounts:${agencyId}` });
        if ((await tx.agencyTelegramMtprotoAccount.count({ where: { agencyId } })) >= ACCOUNT_LIMIT)
          throw fail("TELEGRAM_CONTROL_ACCOUNT_LIMIT", "Remove an unused Telegram connection before adding another");
        const account = await settings.addTelegramMtprotoAccount({
          db: tx,
          agencyId,
          member,
          apiId: p.apiId,
          apiHash: p.apiHash,
        });
        reference = { accountId: account.account.id };
      } else if (c.action === "telegram.reminders") {
        await lockDbAdvisoryXact({ db: tx, key: `telegram-reminders:${agencyId}` });
        if ((await readReminderState(tx, agencyId)).remindersRevision !== p.expectedRevision)
          throw fail("TELEGRAM_REMINDERS_CHANGED", "Reminder settings changed; refresh before saving");
        await settings.updateTelegramCustomReminderSettings({ db: tx, agencyId, member, reminders: p.reminders });
      } else {
        const row = await lockedAccount(tx, agencyId, c.targetId);
        if (!row) throw fail("SETTINGS_TELEGRAM_ACCOUNT_NOT_FOUND", "Telegram connection was not found", 404);
        reference = { accountId: row.id };
        if (c.action === "telegram.session") {
          assertAuthorizationIdle(row, now);
          if (credentialRevision(row) !== p.expectedCredentialRevision)
            throw fail(
              "TELEGRAM_CREDENTIALS_CHANGED",
              "Telegram session changed; start a new authorization after resolving this action"
            );
          const { apiHash } = decryptTelegramCredentials(row);
          const encrypted = encryptTelegramCredentials({ apiHash, session: p.session });
          await tx.agencyTelegramMtprotoAccount.update({ where: { id: row.id }, data: encrypted });
        } else {
          if (accountRevision(row) !== p.expectedRevision)
            throw fail("TELEGRAM_ACCOUNT_CHANGED", "Telegram connection changed; refresh before removing it");
          const call =
            c.action === "telegram.retire"
              ? settings.removeTelegramMtprotoAccount
              : settings.forceRetireLostTelegramMtprotoAccount;
          await call({
            db: tx,
            agencyId,
            member,
            accountId: row.id,
            now,
            reason: p.reason,
            acknowledgeLostObservations: p.acknowledgeLostObservations,
          });
        }
      }
      await audit({
        db: tx,
        required: true,
        agencyId,
        actorUserId: userId,
        action: "telegram_control.committed",
        targetType: c.action,
        targetId: reference.accountId || agencyId,
        metadata: { commandId: c.commandId },
      });
      await store("COMMITTED", reference);
      return {
        ok: true,
        commandId: c.commandId,
        action: c.action,
        replayed: false,
        result: await currentResult(tx, agencyId, c, reference, now),
      };
    },
    { profile: "SECRET_WRITE", authority: { kind: "TELEGRAM_CONTROL", agencyId, userId }, maxAttempts: 1 }
  );
}
async function readTelegramAuthorizationMaterial(args) {
  return runRootCommit(
    args.db,
    async ({ tx }) => {
      await lockAgencyLifecycle({ tx, agencyId: args.agencyId });
      const { now } = await actor(tx, args);
      const row = await lockedAccount(tx, args.agencyId, args.accountId);
      if (!row) throw fail("SETTINGS_TELEGRAM_ACCOUNT_NOT_FOUND", "Telegram connection was not found", 404);
      assertAuthorizationIdle(row, now);
      const { apiHash } = decryptTelegramCredentials(row);
      if (!/^[a-fA-F0-9]{32}$/.test(apiHash))
        throw fail("SETTINGS_TELEGRAM_API_HASH_INVALID", "Stored Telegram API credentials are invalid");
      return { accountId: row.id, apiId: row.apiId, apiHash, session: "", credentialRevision: credentialRevision(row) };
    },
    { profile: "SECRET_WRITE", authority: { kind: "TELEGRAM_AUTHORIZATION_MATERIAL" }, maxAttempts: 1 }
  );
}
module.exports = { ACTIONS, parse, executeTelegramControlCommand, readTelegramAuthorizationMaterial };
