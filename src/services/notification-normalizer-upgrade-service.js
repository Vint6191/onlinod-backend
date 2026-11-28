"use strict";

const { hashCanonicalJson } = require("./realtime-receipt-hash");
const { withCollectorStateLock, COLLECTOR_TYPES } = require("./analytics-collector-control-service");
const { currentCommitContext } = require("./db-commit-kernel");
const { POLICY_VERSION } = require("./creator-live-sync-service");
const FROM_VERSION = "notification-source-v2";
const TO_VERSION = "notification-source-v3";
const REASON = "NOTIFICATION_NORMALIZER_UPGRADE";

// Called only after acceptDelivery validates immutable sequence digests, inside
// the same authorized root commit. Old observations remain in Desktop's durable
// quarantine; their ACK represents an explicit repair obligation, never facts.
async function reconcileLegacyNotificationDelivery({ db, creator, device, session, delivery, now }) {
  if (currentCommitContext()?.tx !== db || session?.creatorId !== creator?.id
    || session?.agencyId !== creator?.agencyId || session?.deviceId !== device?.id) {
    throw Object.assign(new Error("NOTIFICATION_UPGRADE_AUTHORITY_REQUIRED"), { code: "NOTIFICATION_UPGRADE_AUTHORITY_REQUIRED" });
  }
  return withCollectorStateLock({ db, type: COLLECTOR_TYPES.NOTIFICATIONS, creatorId: creator.id, work: async tx => {
    const observations = delivery.entries.map(entry => ({
      seq: entry.seq,
      // Neither client capture time nor provider occurrence time proves this
      // observation was visible to an earlier source walk. Freeze the first
      // trusted server acceptance; replay can never extend this obligation.
      targetAt: new Date(now),
    }));
    const markers = observations.flatMap(entry => ["notifications", "financial"].map(stream => ({
      id: `notifupgrade_${stream}_${hashCanonicalJson([creator.id, session.id, entry.seq, FROM_VERSION, TO_VERSION])}`,
      stream, targetAt: entry.targetAt,
      reason: stream === "notifications" ? REASON : "FINANCIAL_PROOF_ADOPTION_FULL",
    })));
    const existing = await tx.creatorRecoveryIntent.findMany({ where: { id: { in: markers.map(row => row.id) } } });
    const byId = new Map(existing.map(row => [row.id, row]));
    const missing = markers.filter(row => !byId.has(row.id));
    if (missing.length) {
      await tx.creatorRecoveryIntent.createMany({ data: missing.map(row => ({
        id: row.id, agencyId: creator.agencyId, creatorId: creator.id, stream: row.stream, reason: row.reason,
        gapFrom: new Date(0), targetAt: row.targetAt, policyVersion: POLICY_VERSION,
        status: "PENDING",
      })) });
      for (const row of missing) byId.set(row.id, { ...row, status: "PENDING", jobId: null });
    }
    const uncovered = missing;
    if (uncovered.length) {
      const through = new Date(Math.max(...uncovered.map(row => +row.targetAt)));
      // Delivery ACK must not extend the earnings proof across quarantined
      // money. Replays do not increment the receiver's loss revision again.
      await tx.$executeRawUnsafe(`UPDATE "CreatorRealtimeSession" SET loss=true,
        "lossRevision"="lossRevision"+1,"lossAt"=GREATEST("lossAt",$2::timestamp),"updatedAt"=$3
        WHERE id=$1`, session.id, through.toISOString(), now);
      await require("./subscriber-directory-maintenance-signal-service").signalSubscriberDirectoryMaintenance({
        db: tx, agencyId: creator.agencyId, creatorId: creator.id, kind: "DERIVED_PLANNING", reason: REASON,
      });
    }
    const pending = markers.map(row => byId.get(row.id)).filter(row => row.status !== "COMPLETE");
    if (pending.length && !uncovered.length) {
      await require("./subscriber-directory-maintenance-signal-service").ensureSubscriberDirectoryMaintenance({
        db: tx, agencyId: creator.agencyId, creatorId: creator.id, kind: "DERIVED_PLANNING", reason: REASON,
      });
    }
    const notificationJob = pending.find(row => row.stream === "notifications" && row.jobId);
    return { fromVersion: FROM_VERSION, toVersion: TO_VERSION,
      status: pending.length ? "REPAIR_QUEUED" : "REPAIR_COVERED",
      receiptId: hashCanonicalJson([TO_VERSION, session.id, observations.map(row => row.seq)]),
      ...(notificationJob ? { jobId: notificationJob.jobId } : {}) };
  } });
}

module.exports = { FROM_VERSION, TO_VERSION, REASON, reconcileLegacyNotificationDelivery };
