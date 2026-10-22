"use strict";

const crypto = require("node:crypto");
const {
  runDbTransaction
} = require("./db-transaction-service");
const {
  lockCreatorFacts
} = require("./creator-fact-write-authority");
const {
  ingestNotificationFacts
} = require("./notification-facts-service");
const {
  parseStrictIsoDateTime
} = require("./strict-date-time");
const {
  dbAuthorityNow
} = require("./db-time-authority-service");
const VERSION = "notification-source-v2";
const COLLECTOR = "notifications-history-v9-source-ledger";
const categories = {
  purchases: "creatorSale",
  tips: "creatorTip",
  subscriptions: "creatorSubscriptionEvent",
  likes: "creatorPostLike",
  comments: "creatorPostComment"
};
const factTypes = {
  purchases: "PURCHASE",
  tips: "TIP",
  subscriptions: "SUBSCRIPTION",
  likes: "LIKE",
  comments: "COMMENT"
};
const dispositions = new Set(["FACT", "INFORMATION", "UNRESOLVED", "IGNORED", "REJECTED"]);
const targetStates = new Set(["AVAILABLE", "UNAVAILABLE", "DELETED", "DEACTIVATED", "NOT_APPLICABLE"]);
function fail(code, message = code) {
  throw Object.assign(new Error(message), {
    code,
    status: 422
  });
}
function stable(value) {
  return value && typeof value === "object" ? Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}` : JSON.stringify(value);
}
function hash(value) {
  return crypto.createHash("sha256").update(stable(value)).digest("hex");
}
function string(value, max) {
  if (value == null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("NOTIFICATION_OBSERVATION_INVALID");
  return value.trim();
}
function normalizeObservation(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || input.normalizerVersion !== VERSION) fail("NOTIFICATION_NORMALIZER_UNSUPPORTED");
  const row = {};
  for (const [key, max] of Object.entries({
    identityKey: 300,
    notificationId: 220,
    transactionId: 220,
    sourceType: 120,
    sourceSubType: 160,
    category: 40,
    eventType: 100,
    fanOnlyFansUserId: 180,
    fanUsernameAtEvent: 200,
    fanDisplayNameAtEvent: 500,
    fanAvatarUrlAtEvent: 1200,
    messageId: 220,
    postId: 220,
    commentId: 220,
    reasonCode: 160
  })) row[key] = string(input[key], max);
  if (!row.identityKey || row.notificationId && row.identityKey !== `notification:${row.notificationId}` || !row.notificationId && row.transactionId && row.identityKey !== `transaction:${row.transactionId}`) fail("NOTIFICATION_IDENTITY_MISMATCH");
  if (!row.notificationId && !row.transactionId && !(input.disposition === "REJECTED" && /^unidentified:[a-f0-9]{64}$/.test(row.identityKey))) fail("NOTIFICATION_IDENTITY_MISSING");
  if (row.category && !Object.hasOwn(categories, row.category)) fail("NOTIFICATION_CATEGORY_INVALID");
  if (!dispositions.has(input.disposition) || !targetStates.has(input.targetState)) fail("NOTIFICATION_DISPOSITION_INVALID");
  row.disposition = input.disposition;
  row.targetState = input.targetState;
  row.occurredAt = input.occurredAt == null ? null : parseStrictIsoDateTime(input.occurredAt);
  if (input.occurredAt != null && !row.occurredAt) fail("NOTIFICATION_OCCURRED_AT_INVALID");
  if (row.disposition !== "REJECTED" && !row.occurredAt) fail("NOTIFICATION_OCCURRED_AT_REQUIRED");
  row.amountCents = input.amountCents ?? null;
  if (row.amountCents !== null && (!Number.isSafeInteger(row.amountCents) || Math.abs(row.amountCents) > 2147483647)) fail("NOTIFICATION_AMOUNT_INVALID");
  row.currency = string(input.currency, 3);
  if (row.currency && !/^[A-Z]{3}$/.test(row.currency)) fail("NOTIFICATION_CURRENCY_INVALID");
  if (row.disposition === "FACT" && (!row.category || !row.eventType)) fail("NOTIFICATION_FACT_CATEGORY_REQUIRED");
  if (row.disposition === "UNRESOLVED" && (!["likes", "comments"].includes(row.category) || !["UNAVAILABLE", "DELETED"].includes(row.targetState))) fail("NOTIFICATION_UNRESOLVED_INVALID");
  if (row.disposition === "INFORMATION" && !["PRICE_CHANGED", "MEDIA_DEACTIVATED", "FINANCIAL_REVERSAL_NOTICE"].includes(row.eventType)) fail("NOTIFICATION_INFORMATION_INVALID");
  // A strict diagnostic whitelist prevents arbitrary profiles or credentials entering the ledger.
  const evidence = input.sourceEvidence;
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) || Buffer.byteLength(stable(evidence)) > 16384) fail("NOTIFICATION_EVIDENCE_INVALID");
  const allowed = new Set(["id", "type", "subType", "eventType", "action", "createdAt", "timestamp", "occurredAt", "amount", "price", "amountCents", "currency", "messageId", "postId", "commentId", "isDeleted", "postDeleted", "targetState", "replacePairs", "user", "text", "title", "body", "truncated"]);
  if (Object.keys(evidence).some(key => !allowed.has(key))) fail("NOTIFICATION_EVIDENCE_INVALID");
  for (const [key, value] of Object.entries(evidence)) {
    if (key === "user") {
      if (!value || Object.keys(value).some(k => k !== "id") || value.id !== null && typeof value.id !== "string") fail("NOTIFICATION_EVIDENCE_INVALID");
    } else if (key === "replacePairs") {
      if (!value || Array.isArray(value) || Object.entries(value).some(([k, v]) => !["{AMOUNT}", "{PRICE}", "{MESSAGE_LINK}", "{POST_LINK}", "{NAME}"].includes(k) || typeof v !== "string" || v.length > 1200)) fail("NOTIFICATION_EVIDENCE_INVALID");
    } else if (value !== null && !["string", "number", "boolean"].includes(typeof value)) fail("NOTIFICATION_EVIDENCE_INVALID");else if (typeof value === "string" && value.length > 1200) fail("NOTIFICATION_EVIDENCE_INVALID");
  }
  return {
    ...row,
    normalizerVersion: VERSION,
    sourceEvidence: evidence,
    sourceChecksum: hash(input)
  };
}

// Reclassify only an exact creator + notification identity with notification-only
// provenance. Independently reconciled money/manual attribution is a review conflict.
async function repairFormerFacts(db, job, row, now, apply = false, formerFacts = null) {
  if (!row.notificationId || !["FACT", "INFORMATION", "UNRESOLVED"].includes(row.disposition)) return null;
  const former = [];
  for (const [category, model] of Object.entries(categories)) {
    if (category === row.category && row.disposition !== "INFORMATION") continue;
    const fact = formerFacts ? formerFacts.get(model).get(row.notificationId) : await db[model].findUnique({
      where: {
        creatorId_externalNotificationId: {
          creatorId: job.creatorId,
          externalNotificationId: row.notificationId
        }
      }
    });
    if (fact) former.push({
      model,
      fact
    });
  }
  for (const {
    model,
    fact
  } of former) {
    if (fact.externalTransactionId || fact.source && fact.source !== "NOTIFICATION") return "RECLASSIFICATION_AUTHORITY_CONFLICT";
    if (model === "creatorSale" && (await db.teamPpvPurchaseLedger.findFirst({
      where: {
        creatorSaleId: fact.id
      },
      select: {
        id: true
      }
    }))) return "RECLASSIFICATION_ATTRIBUTION_REVIEW";
    if (model === "creatorTip" && (await db.teamTipLedger.findFirst({
      where: {
        creatorTipId: fact.id
      },
      select: {
        id: true
      }
    }))) return "RECLASSIFICATION_ATTRIBUTION_REVIEW";
    if (model === "creatorSubscriptionEvent" && (await db.creatorPaidSubscription.findFirst({
      where: {
        subscriptionEventId: fact.id,
        OR: [{
          externalTransactionId: {
            not: null
          }
        }, {
          source: {
            not: "NOTIFICATION"
          }
        }]
      },
      select: {
        id: true
      }
    }))) return "RECLASSIFICATION_AUTHORITY_CONFLICT";
  }
  if (!apply) return null;
  const affectedFans = [];
  for (const {
    model,
    fact
  } of former) {
    await db.creatorNotificationCorrection.create({
      data: {
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        notificationId: row.notificationId,
        formerModel: model,
        formerFactId: fact.id,
        newEventType: row.eventType,
        reasonCode: "SOURCE_RECLASSIFIED",
        priorEvidence: JSON.parse(JSON.stringify(fact)),
        normalizerVersion: VERSION,
        sourceJobId: job.sourceJobId === null ? null : job.id
      }
    });
    if (model === "creatorSubscriptionEvent") {
      await db.creatorPaidSubscription.deleteMany({
        where: {
          creatorId: job.creatorId,
          subscriptionEventId: fact.id,
          source: "NOTIFICATION",
          externalTransactionId: null
        }
      });
      if (fact.fanRecordId) affectedFans.push(fact.fanRecordId);
    }
    await db[model].delete({
      where: {
        id: fact.id
      }
    });
  }
  if (affectedFans.length) await require("./creator-analytics-projection-service").projectSubscriptionFacts({
    db,
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    fanRecordIds: [...new Set(affectedFans)],
    eventIds: [],
    now
  });
  return null;
}
async function ingestNotificationSourcePage({
  db,
  job,
  deviceId,
  userId = null,
  chunk,
  live = false,
  commitGuard = null
}) {
  if (chunk.schemaVersion !== 6 || chunk.normalizerVersion !== VERSION || chunk.collectorVersion !== COLLECTOR) fail("NOTIFICATION_COLLECTOR_UPGRADE_REQUIRED");
  if (!/^[A-Za-z0-9._-]{8,120}$/.test(chunk.scanRunId || "") || !Number.isSafeInteger(chunk.page) || chunk.page < 1) fail("NOTIFICATION_SOURCE_PAGE_INVALID");
  if (!Array.isArray(chunk.observations) || chunk.observations.length > 25 || chunk.processedRows !== chunk.observations.length) fail("NOTIFICATION_SOURCE_COUNT_MISMATCH");
  const rows = chunk.observations.map(normalizeObservation),
    identities = new Set();
  for (const row of rows) {
    if (identities.has(row.identityKey)) fail("NOTIFICATION_SOURCE_DUPLICATE_IDENTITY");
    identities.add(row.identityKey);
  }
  const batches = chunk.batches;
  if (!Array.isArray(batches) || batches.length > 5) fail("NOTIFICATION_BATCHES_INVALID");
  const events = new Map(),
    seenTypes = new Set();
  for (const batch of batches) {
    if (!Object.hasOwn(categories, batch.notificationType) || seenTypes.has(batch.notificationType) || !Array.isArray(batch.events) || batch.events.length > 100) fail("NOTIFICATION_BATCHES_INVALID");
    seenTypes.add(batch.notificationType);
    for (const event of batch.events) {
      const identity = event.notificationId ? `notification:${event.notificationId}` : `transaction:${event.transactionId}`;
      const row = rows.find(row => row.identityKey === identity);
      if (!row || row.disposition !== "FACT" || row.category !== batch.notificationType || events.has(identity) || event.normalizerVersion !== VERSION) fail("NOTIFICATION_FACT_OBSERVATION_MISMATCH");
      for (const [sourceKey, factKey] of Object.entries({
        eventType: "eventType",
        fanOnlyFansUserId: "fanId",
        amountCents: "amountCents",
        currency: "currency",
        messageId: "messageId",
        postId: "postId",
        commentId: "commentId"
      })) {
        if ((row[sourceKey] ?? null) !== (event[factKey] ?? null)) fail("NOTIFICATION_FACT_OBSERVATION_MISMATCH");
      }
      if (row.occurredAt?.toISOString() !== event.occurredAt) fail("NOTIFICATION_FACT_OBSERVATION_MISMATCH");
      events.set(identity, event);
    }
  }
  if (rows.filter(row => row.disposition === "FACT").length !== events.size) fail("NOTIFICATION_FACT_OBSERVATION_MISMATCH");
  const checksum = hash(chunk),
    key = `notification-source-page:${hash([job.agencyId, job.creatorId, job.id])}:run:${chunk.scanRunId}:source-page:${chunk.page}:v1`;
  return runDbTransaction(db, async tx => {
    if (commitGuard) await commitGuard(tx);
    await lockCreatorFacts(tx, job.agencyId, job.creatorId);
    if (!(await tx.creatorAccount.findFirst({
      where: {
        id: job.creatorId,
        agencyId: job.agencyId,
        deletedAt: null,
        status: {
          not: "DISABLED"
        }
      },
      select: {
        id: true
      }
    }))) fail("NOTIFICATION_CREATOR_SCOPE_INVALID");
    if (deviceId && !(await tx.workerDevice.findFirst({
      where: {
        id: deviceId,
        agencyId: job.agencyId
      },
      select: {
        id: true
      }
    }))) fail("NOTIFICATION_DEVICE_SCOPE_INVALID");
    const prior = await tx.analyticsIngestBatch.findUnique({
      where: {
        idempotencyKey: key
      }
    });
    if (prior) {
      if (prior.payloadChecksum !== checksum) fail("ANALYTICS_INGEST_IDEMPOTENCY_CONFLICT");
      if (["COMMITTED", "PARTIAL"].includes(prior.status)) return {
        replayed: true,
        status: prior.status,
        batchId: prior.id
      };
      fail("NOTIFICATION_SOURCE_RECEIPT_INCOMPLETE");
    }
    const now = await dbAuthorityNow({
      db: tx,
      fallbackNow: new Date()
    });
    const outcomes = new Map(),
      formerFacts = new Map();
    const notificationIds = rows.map(row => row.notificationId).filter(Boolean);
    for (const model of Object.values(categories)) {
      const facts = notificationIds.length ? await tx[model].findMany({
        where: {
          creatorId: job.creatorId,
          externalNotificationId: {
            in: notificationIds
          }
        }
      }) : [];
      formerFacts.set(model, new Map(facts.map(fact => [fact.externalNotificationId, fact])));
    }
    const previousEvents = rows.length ? await tx.creatorNotificationEvent.findMany({
      where: {
        creatorId: job.creatorId,
        identityKey: {
          in: rows.map(row => row.identityKey)
        }
      }
    }) : [];
    const previousByIdentity = new Map(previousEvents.map(row => [row.identityKey, row]));
    for (const row of rows) {
      const reason = await repairFormerFacts(tx, job, row, now, false, formerFacts);
      if (reason) outcomes.set(row.identityKey, {
        status: "REJECTED",
        reasonCode: reason
      });
    }
    const ledgers = [];
    for (const batch of batches) {
      const accepted = batch.events.filter(event => !outcomes.has(event.notificationId ? `notification:${event.notificationId}` : `transaction:${event.transactionId}`));
      if (!accepted.length) continue;
      const ledger = await ingestNotificationFacts({
        db: tx,
        job,
        deviceId,
        result: {
          events: accepted,
          notificationType: batch.notificationType,
          batchKey: batch.batchKey,
          finalizeCoverage: false,
          sourceTimezone: "UTC",
          scanRunId: chunk.scanRunId,
          collectorVersion: COLLECTOR,
          schemaVersion: 6,
          coverage: {
            [batch.notificationType]: {
              status: "partial"
            }
          }
        }
      });
      if (ledger.replayed) fail("NOTIFICATION_SOURCE_RECEIPT_GAP");
      if (!Array.isArray(ledger.rowOutcomes) || ledger.rowOutcomes.length !== accepted.length) fail("NOTIFICATION_FACT_RECEIPT_MISSING");
      for (const outcome of ledger.rowOutcomes) outcomes.set(outcome.notificationId ? `notification:${outcome.notificationId}` : `transaction:${outcome.transactionId}`, outcome);
      ledgers.push({
        notificationType: batch.notificationType,
        ...ledger
      });
    }
    const auditItems = [],
      newEvents = [],
      changedEvents = [],
      unchangedIds = [];
    for (let ordinal = 0; ordinal < rows.length; ordinal++) {
      const row = rows[ordinal],
        outcome = outcomes.get(row.identityKey);
      const persistenceStatus = outcome?.status || {
        INFORMATION: "EVENT_STORED",
        UNRESOLVED: "TARGET_UNAVAILABLE",
        IGNORED: "IGNORED_STORED",
        REJECTED: "REJECTED"
      }[row.disposition];
      if (!persistenceStatus) fail("NOTIFICATION_PERSISTENCE_RESULT_MISSING");
      const rejected = persistenceStatus === "REJECTED",
        reasonCode = outcome?.reasonCode || row.reasonCode;
      if (!rejected) {
        const conflict = await repairFormerFacts(tx, job, row, now, true, formerFacts);
        if (conflict) fail(conflict);
      }
      const data = {
        ...row,
        reasonCode,
        disposition: rejected ? "REJECTED" : row.disposition,
        persistenceStatus,
        canonicalFactId: outcome?.canonicalFactId || null,
        sourceJobId: job.sourceJobId === null ? null : job.id,
        scanRunId: chunk.scanRunId,
        lastObservedAt: now
      };
      const previous = previousByIdentity.get(row.identityKey);
      // A later malformed/out-of-range observation never erases committed history.
      const preserve = previous && ["FACT_COMMITTED", "EVENT_STORED", "TARGET_UNAVAILABLE"].includes(previous.persistenceStatus) && ["REJECTED", "IGNORED_STORED"].includes(persistenceStatus);
      const canonical = previous || {
        id: crypto.randomUUID()
      };
      if (!preserve) {
        if (!previous) newEvents.push({
          id: canonical.id,
          agencyId: job.agencyId,
          creatorId: job.creatorId,
          ...data
        });else if (previous.sourceChecksum === data.sourceChecksum && previous.persistenceStatus === data.persistenceStatus && previous.canonicalFactId === data.canonicalFactId) unchangedIds.push(previous.id);else changedEvents.push({
          id: previous.id,
          data
        });
      }
      auditItems.push({
        ...row,
        sourcePhase: chunk.sourcePhase || "live",
        page: chunk.page,
        ordinal,
        occurredAt: row.occurredAt?.toISOString() || null,
        factType: factTypes[row.category] || null,
        eventKind: row.eventType,
        targetState: row.targetState,
        persistenceStatus,
        canonicalEventId: canonical.id,
        outcome: rejected ? "REJECTED" : row.disposition === "IGNORED" ? "IGNORED" : "ACCEPTED",
        reasonCode
      });
    }
    if (newEvents.length) await tx.creatorNotificationEvent.createMany({
      data: newEvents
    });
    for (const item of changedEvents) await tx.creatorNotificationEvent.update({
      where: {
        id: item.id
      },
      data: item.data
    });
    if (unchangedIds.length) await tx.creatorNotificationEvent.updateMany({
      where: {
        id: {
          in: unchangedIds
        },
        creatorId: job.creatorId
      },
      data: {
        lastObservedAt: now,
        sourceJobId: job.sourceJobId === null ? null : job.id,
        scanRunId: chunk.scanRunId
      }
    });
    // Only facts acknowledged by persistence may create dialog purchase signals.
    const signals = rows.filter(row => row.category === "purchases" && outcomes.get(row.identityKey)?.status === "FACT_COMMITTED").map(row => {
      const event = events.get(row.identityKey);
      return {
        sourceEventId: row.notificationId || row.transactionId,
        sourceMessageId: row.messageId,
        dialogId: event.dialogId || row.fanOnlyFansUserId,
        buyerId: row.fanOnlyFansUserId,
        occurredAt: row.occurredAt.toISOString(),
        amountCents: row.amountCents,
        currency: row.currency,
        source: "purchase_notification",
        metadata: {
          postId: row.postId,
          eventHash: event.eventHash || null,
          targetUrl: event.targetUrl || null
        }
      };
    });
    if (!live && signals.length) await require("./dialog-intelligence-service").applyPurchaseSignalsChunk({
      db: tx,
      job,
      deviceId,
      userId,
      chunkResult: {
        kind: "dialog_purchase_signals",
        signals
      }
    });
    const rejectedRows = auditItems.filter(row => row.outcome === "REJECTED").length;
    const receipt = await tx.analyticsIngestBatch.create({
      data: {
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        sourceJobId: job.sourceJobId === null ? null : job.id,
        sourceDeviceId: deviceId || null,
        idempotencyKey: key,
        dataType: "NOTIFICATIONS",
        status: rejectedRows ? "PARTIAL" : "COMMITTED",
        rangeFrom: new Date(job.params.from),
        rangeTo: new Date(job.params.to),
        sourceTimezone: "UTC",
        collectorVersion: COLLECTOR,
        schemaVersion: 6,
        payloadChecksum: checksum,
        receivedRows: rows.length,
        insertedRows: auditItems.length - rejectedRows,
        rejectedRows,
        completedAt: now,
        lastErrorCode: rejectedRows ? "NOTIFICATION_ROWS_REJECTED" : null
      }
    });
    let notificationState = null;
    if (!live) {
      await require("./notification-scan-control-service").recordNotificationScanItems({
        db: tx,
        job,
        verifiedSource: true,
        chunk: {
          ...chunk,
          auditItems
        }
      });
      notificationState = await require("./notification-sync-state-service").recordNotificationPageProgress({
        db: tx,
        job,
        deviceId,
        frontierAssessment: require("./notification-frontier-authority").assessPage(job, rows, previousByIdentity, outcomes),
        chunk: {
          ...chunk,
          rejectedRows,
          acceptedRows: auditItems.filter(row => row.outcome === "ACCEPTED").length
        }
      });
    }
    return {
      type: "notification_source_page",
      replayed: false,
      batchId: receipt.id,
      status: receipt.status,
      observed: rows.length,
      rejected: rejectedRows,
      batches: ledgers,
      ...(notificationState?.frontierReceipt ? { notificationFrontier: notificationState.frontierReceipt } : {})
    };
  }, {
    maxWait: 10000,
    timeout: 60000
  });
}
module.exports = {
  ingestNotificationSourcePage,
  normalizeObservation,
  VERSION,
  COLLECTOR
};
