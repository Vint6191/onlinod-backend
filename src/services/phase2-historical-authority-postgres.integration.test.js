"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";
const { authorizeFixtureTransaction, withFixtureAuthorities, cleanupAgencyFixture } = require("../../scripts/test-support/phase2-postgres-integration-authority");

async function rollbackTx(prisma, work, sentinel) {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '4s'");
      await work(tx);
      throw new Error(sentinel);
    }, { timeout: 15_000 });
    throw new Error(`${sentinel}: transaction unexpectedly committed`);
  } catch (err) {
    if (err?.message !== sentinel) throw err;
  }
}

function token(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

test("Phase2 PostgreSQL historical authority: DB triggers create durable projection before proof", { skip: !enabled }, async (t) => {
  const prisma = require("../prisma");
  try {
    await rollbackTx(prisma, async (tx) => {
      await authorizeFixtureTransaction(tx, { team: true });
      const agency = { id: token("phase2_agency") };
      await tx.$executeRawUnsafe(
        `INSERT INTO "Agency" ("id","name","plan","status","createdAt","updatedAt")
         VALUES ($1,$2,'trial','TRIAL',clock_timestamp(),clock_timestamp())`,
        agency.id, `Phase2 historical PG ${agency.id}`,
      );
      const eventId = token("phase2_activity");
      const memberId = token("member");
      const accountId = token("creator_ref");
      const eventTs = new Date();

      const insertedEvents = await tx.$queryRawUnsafe(`
        INSERT INTO "TeamActivityEvent" (
          "id", "agencyId", "memberId", "accountId", "type", "eventKind",
          "actionSource", "lifecycle", "priceCents", "isPpv", "mediaCount",
          "ts", "source", "createdAt"
        ) VALUES ($1, $2, $3, $4, 'message_send_confirmed', 'MESSAGE_SEND_CONFIRMED',
                  'MANUAL', 'CONFIRMED', 500, TRUE, 0, $5, 'electron_team_v13', clock_timestamp())
        RETURNING "historicalProjectionVersion", "historicalProjectedAt"
      `, eventId, agency.id, memberId, accountId, eventTs);

      assert.equal(insertedEvents?.[0]?.historicalProjectionVersion, "team_activity_daily_v1");
      assert.ok(insertedEvents?.[0]?.historicalProjectedAt);

      const daily = await tx.$queryRawUnsafe(`
        SELECT "messagesSent", "ppvSentMessages", "sourceEventCount", "projectionVersion"
        FROM "TeamMemberActivityDaily"
        WHERE "agencyId" = $1 AND "memberId" = $2 AND "creatorKey" = $3
          AND "day" = date_trunc('day', $4::timestamp)
        LIMIT 1
      `, agency.id, memberId, accountId, eventTs);
      assert.equal(Number(daily?.[0]?.messagesSent), 1);
      assert.equal(Number(daily?.[0]?.ppvSentMessages), 1);
      assert.equal(Number(daily?.[0]?.sourceEventCount), 1);
      assert.equal(daily?.[0]?.projectionVersion, "team_activity_daily_v1");

      // A high-volume zero-contribution event still receives retention proof but
      // must not contend on TeamMemberActivityDaily. Response/pending projections
      // are committed by the canonical ingest transaction outside this trigger.
      const incomingId = token("phase2_incoming");
      const incomingMember = token("incoming_member");
      const incomingAccount = token("incoming_creator_ref");
      const incomingRows = await tx.$queryRawUnsafe(`
        INSERT INTO "TeamActivityEvent" (
          "id", "agencyId", "memberId", "accountId", "type", "eventKind",
          "actionSource", "lifecycle", "priceCents", "isPpv", "mediaCount",
          "ts", "source", "createdAt"
        ) VALUES ($1, $2, $3, $4, 'fan_message_received', 'FAN_MESSAGE_RECEIVED',
                  'SYSTEM', 'CONFIRMED', 0, FALSE, 0, clock_timestamp(), 'electron_team_v13', clock_timestamp())
        RETURNING "historicalProjectionVersion", "historicalProjectedAt"
      `, incomingId, agency.id, incomingMember, incomingAccount);
      assert.equal(incomingRows?.[0]?.historicalProjectionVersion, "team_activity_daily_v1");
      assert.ok(incomingRows?.[0]?.historicalProjectedAt);
      const incomingDaily = await tx.$queryRawUnsafe(`
        SELECT "id" FROM "TeamMemberActivityDaily"
        WHERE "agencyId" = $1 AND "memberId" = $2 AND "creatorKey" = $3
        LIMIT 1
      `, agency.id, incomingMember, incomingAccount);
      assert.equal(incomingDaily.length, 0);

      const ppvId = token("phase2_ppv");
      const purchaseId = token("purchase");
      const ppvMember = token("ppv_member");
      const ppvRows = await tx.$queryRawUnsafe(`
        INSERT INTO "TeamPpvPurchaseLedger" (
          "id", "agencyId", "accountId", "purchaseId", "amountCents", "currency",
          "purchasedAt", "status", "attributedMemberId", "financialStatus", "createdAt", "updatedAt"
        ) VALUES ($1, $2, 'phase2_pg', $3, 2500, 'USD', clock_timestamp(), 'attributed', $4, NULL,
                  clock_timestamp(), clock_timestamp())
        RETURNING "historicalFactVersion", "historicalFactProjectedAt"
      `, ppvId, agency.id, purchaseId, ppvMember);
      assert.equal(ppvRows?.[0]?.historicalFactVersion, "team_money_fact_v1");
      assert.ok(ppvRows?.[0]?.historicalFactProjectedAt);

      const ppvFact = await tx.$queryRawUnsafe(`
        SELECT "sourceType", "sourceRowId", "memberId", "amountCents", "attributionActive", "projectionVersion"
        FROM "TeamMoneyAttributionFact"
        WHERE "agencyId" = $1 AND "sourceType" = 'PPV' AND "sourceRowId" = $2
      `, agency.id, ppvId);
      assert.equal(ppvFact?.[0]?.sourceType, "PPV");
      assert.equal(ppvFact?.[0]?.sourceRowId, ppvId);
      assert.equal(ppvFact?.[0]?.memberId, ppvMember);
      assert.equal(Number(ppvFact?.[0]?.amountCents), 2500);
      assert.equal(ppvFact?.[0]?.attributionActive, true);
      assert.equal(ppvFact?.[0]?.projectionVersion, "team_money_fact_v1");

      const tipId = token("phase2_tip");
      const externalTipId = token("tip");
      const tipMember = token("tip_member");
      const tipRows = await tx.$queryRawUnsafe(`
        INSERT INTO "TeamTipLedger" (
          "id", "agencyId", "accountId", "eventHash", "tipId", "amountCents", "currency",
          "receivedAt", "status", "attributedMemberId", "financialStatus", "createdAt", "updatedAt"
        ) VALUES ($1, $2, 'phase2_pg', $3, $4, 1500, 'EUR', clock_timestamp(), 'claimed', $5, NULL,
                  clock_timestamp(), clock_timestamp())
        RETURNING "historicalFactVersion", "historicalFactProjectedAt"
      `, tipId, agency.id, token("hash"), externalTipId, tipMember);
      assert.equal(tipRows?.[0]?.historicalFactVersion, "team_money_fact_v1");
      assert.ok(tipRows?.[0]?.historicalFactProjectedAt);

      const tipFact = await tx.$queryRawUnsafe(`
        SELECT "sourceType", "sourceRowId", "memberId", "amountCents", "currency", "attributionActive", "projectionVersion"
        FROM "TeamMoneyAttributionFact"
        WHERE "agencyId" = $1 AND "sourceType" = 'TIP' AND "sourceRowId" = $2
      `, agency.id, tipId);
      assert.equal(tipFact?.[0]?.sourceType, "TIP");
      assert.equal(tipFact?.[0]?.sourceRowId, tipId);
      assert.equal(tipFact?.[0]?.memberId, tipMember);
      assert.equal(Number(tipFact?.[0]?.amountCents), 1500);
      assert.equal(tipFact?.[0]?.currency, "EUR");
      assert.equal(tipFact?.[0]?.attributionActive, true);
      assert.equal(tipFact?.[0]?.projectionVersion, "team_money_fact_v1");
    }, "PHASE2_HISTORICAL_TRIGGER_ROLLBACK");
  } finally {
    if (typeof prisma.$disconnect === "function") await prisma.$disconnect();
  }
});
