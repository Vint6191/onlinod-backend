
"use strict";

const prisma = require("../prisma");
const { ensureSingleJob } = require("./job-scheduler");

const PRESENCE_JOB_KEY = "refresh_online_presence";
const PRESENCE_JOB_INTERVAL_MS = Number(process.env.ONLINOD_PRESENCE_REFRESH_MS || 12 * 60 * 1000);
const PRESENCE_SWEEP_INTERVAL_MS = Number(process.env.ONLINOD_PRESENCE_SWEEP_MS || 60 * 1000);
const ACTIVE_DEVICE_WINDOW_MS = Number(process.env.ONLINOD_PRESENCE_ACTIVE_DEVICE_MS || 5 * 60 * 1000);

async function ensurePresenceJobForCreator({ creatorId, agencyId, priority = 70, reason = "scheduled_presence_refresh" }) {
  return ensureSingleJob({
    jobKey: PRESENCE_JOB_KEY,
    creatorId,
    agencyId,
    params: { kind: "online_presence", reason },
    priority,
    now: new Date(),
    freshnessWindowMs: PRESENCE_JOB_INTERVAL_MS,
  });
}

async function runPresenceSweep() {
  const activeSince = new Date(Date.now() - ACTIVE_DEVICE_WINDOW_MS);
  const bindings = await prisma.deviceCreatorBinding.findMany({
    where: {
      status: "ACTIVE",
      lastSeenAt: { gte: activeSince },
      creator: { status: "READY", deletedAt: null, agency: { deletedAt: null } },
      device: { lastSeenAt: { gte: activeSince } },
    },
    select: { creatorId: true, agencyId: true },
    distinct: ["creatorId"],
  });

  let created = 0;
  let skipped = 0;
  for (const binding of bindings) {
    const decision = await ensurePresenceJobForCreator({ creatorId: binding.creatorId, agencyId: binding.agencyId });
    if (decision.created) created += 1;
    else skipped += 1;
  }

  return { creatorsWithActiveDevices: bindings.length, created, skipped };
}

let timer = null;
function startPresenceScheduler({ intervalMs = PRESENCE_SWEEP_INTERVAL_MS, runImmediately = true } = {}) {
  if (timer) return () => stopPresenceScheduler();

  const tick = () => {
    runPresenceSweep().catch((err) => console.error("[presence-scheduler] sweep crashed:", err));
  };

  if (runImmediately) setTimeout(tick, 20 * 1000);
  timer = setInterval(tick, intervalMs);
  console.log(`[presence-scheduler] started (sweep=${intervalMs}ms, job freshness=${PRESENCE_JOB_INTERVAL_MS}ms)`);
  return () => stopPresenceScheduler();
}

function stopPresenceScheduler() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  console.log("[presence-scheduler] stopped");
}

module.exports = {
  PRESENCE_JOB_KEY,
  PRESENCE_JOB_INTERVAL_MS,
  ensurePresenceJobForCreator,
  runPresenceSweep,
  startPresenceScheduler,
  stopPresenceScheduler,
};
