"use strict";

// The Data Change Processor coordinates existing fact owners. Delivery ACK is
// still returned only after the same fenced transaction commits facts, their
// durable consequences and live-sync receipt. No empty intermediary queue may
// advance the financial delivery watermark.
const crypto = require("node:crypto");
const { ingestNotificationFacts, normalizeEvent: normalizeNotificationFact } = require("./notification-facts-service");
const { recordNotificationSocketEvent } = require("./notification-sync-state-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { currentCommitContext } = require("./db-commit-kernel");

async function processLiveNotificationBatch({db: tx, creator, member, device, input}) {
    if (currentCommitContext()?.tx !== tx) throw Object.assign(new Error("DATA_CHANGE_OWNER_TRANSACTION_REQUIRED"), {code:"DATA_CHANGE_OWNER_TRANSACTION_REQUIRED"});
    const grouped = new Map();
    const dates = [];
    const sourceEvents=input.events.filter(event=>event.normalizerVersion === "notification-source-v2" && event.notificationObservation);
    for(const event of sourceEvents){const row=require("./notification-source-ledger-service").normalizeObservation(event.notificationObservation);if(row.occurredAt)dates.push(row.occurredAt);}
    for (const raw of input.events.filter(event=>!sourceEvents.includes(event))) {
      const normalized = normalizeNotificationFact(raw, creator.id);
      if (!normalized.sourceType || normalized.rejected) {
        throw Object.assign(new Error(normalized.rejected || "Unsupported live notification event"), {code:"LIVE_NOTIFICATION_EVENT_REJECTED", status:422});
      }
      if (!grouped.has(normalized.sourceType)) grouped.set(normalized.sourceType, []);
      grouped.get(normalized.sourceType).push(raw);
      if (normalized.occurredAt) dates.push(normalized.occurredAt);
    }
    const observedAt = new Date(input.observedAt);
    const rangeFrom = dates.length ? new Date(Math.min(...dates.map((date) => date.getTime())) - 5 * 60 * 1000) : new Date(observedAt.getTime() - 5 * 60 * 1000);
    const rangeTo = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime())) + 5 * 60 * 1000) : new Date(observedAt.getTime() + 5 * 60 * 1000);
    const logicalJob = {
      id: `live_${input.batchId}`,
      agencyId: creator.agencyId,
      creatorId: creator.id,
      sourceJobId: null,
      params: {
        from: rangeFrom.toISOString(),
        to: rangeTo.toISOString(),
        types: [...grouped.keys()],
        notificationMode: "catchup",
      },
    };
        const ingest = async () => {
          const results = [];
          if (sourceEvents.length) {
            const batches = ["purchases","tips","subscriptions","likes","comments"].map(type => ({ notificationType: type,
              batchKey: `run:${input.batchId}:page:${type}:${crypto.createHash("sha256").update(`${input.batchId}|source|${type}`).digest("hex").slice(0,24)}`,
              events: sourceEvents.filter(event => event.notificationObservation.category === type && event.notificationObservation.disposition === "FACT").map(event => event.notificationFact),
            }));
            const sourceJob = { ...logicalJob, params: { ...logicalJob.params, types: ["purchases","tips","subscriptions","likes","comments"] } };
            results.push(await require("./notification-source-ledger-service").ingestNotificationSourcePage({
              db: tx, job: sourceJob, deviceId: device.id, live: true,
              chunk: { schemaVersion:6, normalizerVersion:"notification-source-v2", collectorVersion:"notifications-history-v9-source-ledger",
                scanRunId:input.batchId, page:1, observations:sourceEvents.map(event=>event.notificationObservation), batches, processedRows:sourceEvents.length },
            }));
          }
          for (const [type, events] of grouped) {
            const typeHash = crypto.createHash("sha256").update(`${input.batchId}|${type}`).digest("hex").slice(0,24);
            results.push(await ingestNotificationFacts({ db: tx, job: logicalJob, deviceId: device.id,
              result: { events, notificationType:type, batchKey:`run:${input.batchId}:page:${type}:${typeHash}`,
                finalizeCoverage:false, sourceTimezone:input.sourceTimezone, scanRunId:input.batchId,
                collectorVersion:"notifications-all-v5", schemaVersion:4, coverage:{[type]:{status:"partial"}} },
            }));
          }
          results.push(await require("./live-earnings-projection-service").ingestLive({ db:tx,
            agencyId:creator.agencyId,creatorId:creator.id,deviceId:device.id,events:input.events,
            capturedAt:observedAt,capturedTimes:input.delivery?.entries.map(entry=>entry.capturedAt),now:await dbAuthorityNow({db:tx}) }));
          await recordNotificationSocketEvent({ db:tx, agencyId:creator.agencyId, creatorId:creator.id, deviceId:device.id,
            occurredAt:dates.length ? new Date(Math.max(...dates.map(date=>date.getTime()))) : observedAt });
          return results;
        };
        if (!input.delivery) return { results: await ingest() };
        return require("./creator-live-sync-service").acceptDelivery({ db:tx, agencyId:creator.agencyId,
          creatorId:creator.id, deviceId:device.id, memberId:member.id, accessEpoch:member.accessEpoch,
          delivery:input.delivery, events:input.events, now:await dbAuthorityNow({db:tx}), ingest });
}

module.exports = { processLiveNotificationBatch };
