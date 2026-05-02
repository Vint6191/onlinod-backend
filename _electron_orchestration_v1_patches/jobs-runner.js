/* electron/main/jobs-runner.js
   ────────────────────────────────────────────────────────────
   Electron main-process loop that does the actual work.
   
   Loop:
     1. Every JOBS_INTERVAL_MS (default 30s):
        a. POST /api/jobs/claim → get one job (or null)
        b. If got one: execute it (calls existing browserApiRunner)
        c. POST /api/stats/.../upsert with the result
        d. POST /api/jobs/:id/report with ok/error
   
   Job types implemented:
     - fetch_earnings(creatorId, rangeKey)  → uses getCreatorNumbersPayload
     - fetch_campaigns(creatorId)           → uses getCreatorCampaignsPayload
   
   Other job types are reported as "not implemented" so they
   transition to FAILED and don't loop forever.
   
   Wiring (in index.js):
   
     const { startJobsRunner, stopJobsRunner } = require("./jobs-runner");
     
     startJobsRunner({
       getBackendAuthClient,
       backendAuthSessionStore,
       getCreatorNumbersPayload,    // existing function in index.js
       getCreatorCampaignsPayload,  // existing function in index.js
       readAccountManifest,         // existing function
     });
   ────────────────────────────────────────────────────────────
*/

"use strict";

const JOBS_INTERVAL_MS = Number(process.env.ONLINOD_JOBS_MS) || 30 * 1000;
const JOBS_FIRST_DELAY_MS = 15 * 1000;  // wait a bit after heartbeat starts


let runner = null;


async function tryRunOneJob(deps) {
  const {
    getBackendAuthClient,
    backendAuthSessionStore,
    getCreatorNumbersPayload,
    getCreatorCampaignsPayload,
    readAccountManifest,
  } = deps;

  const session = backendAuthSessionStore?.read?.();
  if (!session?.accessToken && !session?.refreshToken) {
    return { ok: false, reason: "no-session" };
  }

  const deviceId = session.deviceId;
  if (!deviceId) {
    return { ok: false, reason: "no-deviceId" };
  }

  const client = getBackendAuthClient();

  // 1. Claim a job.
  let claimResponse;
  try {
    claimResponse = await client.request("/api/jobs/claim", {
      method: "POST",
      body: { deviceId },
    });
  } catch (err) {
    return { ok: false, reason: "claim-failed", error: String(err?.message || err) };
  }

  const job = claimResponse?.job;
  if (!job) {
    return { ok: true, reason: claimResponse?.reason || "no-work" };
  }

  if (deps.verbose) {
    console.log(`[jobs] claimed ${job.jobKey} for ${job.creatorId || "agency:" + job.agencyId} (params=${JSON.stringify(job.params || {})})`);
  }

  // 2. Execute.
  let result;
  try {
    result = await executeJob(job, deps);
  } catch (err) {
    result = { ok: false, error: String(err?.message || err) };
  }

  // 3. Report.
  try {
    await client.request(`/api/jobs/${encodeURIComponent(job.id)}/report`, {
      method: "POST",
      body: {
        deviceId,
        ok: !!result?.ok,
        error: result?.ok ? null : (result?.error || "unknown"),
        result: result?.ok ? (result.summary || null) : null,
      },
    });
  } catch (err) {
    console.warn("[jobs] report failed:", err?.message || err);
  }

  if (deps.verbose) {
    console.log(`[jobs] ${result?.ok ? "DONE" : "FAILED"} ${job.jobKey}: ${result?.ok ? "ok" : (result?.error || "?")}`);
  }

  return { ok: true, executed: true, jobId: job.id, jobOk: !!result?.ok };
}


// ════════════════════════════════════════════════════════════
// Execute by jobKey
// ════════════════════════════════════════════════════════════

async function executeJob(job, deps) {
  const {
    readAccountManifest,
    getCreatorNumbersPayload,
    getCreatorCampaignsPayload,
    getBackendAuthClient,
    backendAuthSessionStore,
  } = deps;

  const client = getBackendAuthClient();
  const deviceId = backendAuthSessionStore?.read?.()?.deviceId;

  if (job.jobKey === "fetch_earnings") {
    if (!job.creatorId) return { ok: false, error: "fetch_earnings requires creatorId" };
    const account = readAccountManifest(job.creatorId);
    if (!account?.id) return { ok: false, error: "Account manifest not found" };

    const rangeKey = (job.params || {}).rangeKey || "7d";
    const payload = await getCreatorNumbersPayload(account, rangeKey);
    if (!payload?.ok) return { ok: false, error: payload?.error || payload?.code || "fetch failed" };

    // Upsert via stats API.
    const upsert = await client.request("/api/stats/earnings/upsert", {
      method: "POST",
      body: {
        deviceId,
        creatorId: job.creatorId,
        rangeKey,
        range: payload.range
          ? { startDate: payload.range.startDate, endDate: payload.range.endDate }
          : undefined,
        summary: {
          total:      Math.round((payload.summary?.total      || 0) * 100),
          gross:      Math.round((payload.summary?.gross      || 0) * 100),
          delta:      Math.round((payload.summary?.delta      || 0) * 100),
          avgSale:    Math.round((payload.summary?.avgSale    || 0) * 100),
          fanLtv:     Math.round((payload.summary?.fanLtv     || 0) * 100),
          salesCount: payload.summary?.salesCount || 0,
          uniqueFans: payload.summary?.uniqueFans || 0,
        },
        raw: payload.raw || null,
        jobId: job.id,
      },
    });

    if (!upsert?.ok) {
      return { ok: false, error: upsert?.error || "upsert failed" };
    }

    return {
      ok: true,
      summary: {
        rangeKey,
        total: payload.summary?.total || 0,
        salesCount: payload.summary?.salesCount || 0,
      },
    };
  }

  if (job.jobKey === "fetch_campaigns") {
    if (!job.creatorId) return { ok: false, error: "fetch_campaigns requires creatorId" };
    const account = readAccountManifest(job.creatorId);
    if (!account?.id) return { ok: false, error: "Account manifest not found" };

    const rangeKey = (job.params || {}).rangeKey || "7d";
    const payload = await getCreatorCampaignsPayload(account, rangeKey);
    if (!payload?.ok) return { ok: false, error: payload?.error || payload?.code || "fetch failed" };

    const upsert = await client.request("/api/stats/campaigns/upsert", {
      method: "POST",
      body: {
        deviceId,
        creatorId: job.creatorId,
        rangeKey,
        campaigns: Array.isArray(payload.campaigns) ? payload.campaigns : [],
        jobId: job.id,
      },
    });

    if (!upsert?.ok) {
      return { ok: false, error: upsert?.error || "upsert failed" };
    }

    return {
      ok: true,
      summary: { rangeKey, campaignCount: (payload.campaigns || []).length },
    };
  }

  return { ok: false, error: `Unknown jobKey: ${job.jobKey}` };
}


// ════════════════════════════════════════════════════════════
// Loop
// ════════════════════════════════════════════════════════════

function startJobsRunner(deps) {
  if (runner) {
    console.warn("[jobs] already running, ignoring start");
    return runner;
  }

  let timer = null;
  let stopped = false;
  let inFlight = false;

  async function tick() {
    if (stopped) return;
    if (inFlight) return;
    inFlight = true;

    try {
      // Drain up to 3 jobs in a row if we have work — keeps catch-up
      // fast after a "refresh all" without spamming claim every tick.
      let executedThisTick = 0;
      for (let i = 0; i < 3; i++) {
        const result = await tryRunOneJob(deps);
        if (!result?.ok) break;
        if (!result.executed) break;
        executedThisTick += 1;
      }

      if (deps.verbose && executedThisTick > 0) {
        console.log(`[jobs] tick: executed ${executedThisTick} job(s)`);
      }
    } catch (err) {
      console.error("[jobs] tick crashed:", err?.message || err);
    } finally {
      inFlight = false;
    }
  }

  setTimeout(() => {
    tick();
    timer = setInterval(tick, JOBS_INTERVAL_MS);
  }, JOBS_FIRST_DELAY_MS);

  runner = {
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      runner = null;
    },
    triggerNow: tick,
  };

  return runner;
}

function stopJobsRunner() {
  if (runner) runner.stop();
}


module.exports = {
  startJobsRunner,
  stopJobsRunner,
};
