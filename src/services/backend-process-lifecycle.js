"use strict";

// The executable owns process signals and Prisma. Imported services never
// disconnect the shared client underneath admitted HTTP or background work.
function createBackendProcessLifecycle({ db, log, processPort = process, timeoutMs = 25_000,
  schedule = setTimeout, cancel = clearTimeout }) {
  const owners = new Map();
  const drains = new Map();
  let phase = "STARTING", startup = null, startupResult = null, stopping = null, failed = false, exited = false;

  function checkpoint() {
    if (phase === "DRAINING" || phase === "STOPPED") throw Object.assign(new Error("BACKEND_STOPPING"), { code: "BACKEND_STOPPING" });
  }
  function drain(name, stop) {
    if (drains.has(name)) return;
    let settled;
    drains.set(name, new Promise(resolve => { settled = resolve; }));
    try { void Promise.resolve(stop()).then(() => settled(null), error => settled({ name, error })); }
    catch (error) { settled({ name, error }); }
  }
  function own(name, stop) {
    if (owners.has(name)) throw new Error(`Duplicate process owner: ${name}`);
    if (typeof stop !== "function") throw new Error(`Missing stop function: ${name}`);
    owners.set(name, stop);
    if (phase === "DRAINING" || phase === "STOPPED") drain(name, stop);
  }
  function finish(code) {
    if (exited) return;
    exited = true;
    phase = "STOPPED";
    for (const [name, handler] of listeners) processPort.removeListener(name, handler);
    processPort.exit(code);
  }
  function stop(reason, error = null) {
    if (error != null && error.code !== "BACKEND_STOPPING") {
      failed = true;
      log.error("backend lifecycle failed", { reason, error: String(error?.message || error) });
    }
    if (stopping) return stopping;
    phase = "DRAINING";
    log.info("shutdown requested", { reason });
    // Keep this deadline referenced even when the last socket has already
    // closed: a pending promise alone does not keep Node alive for cleanup.
    const deadline = schedule(() => {
      log.warn("graceful shutdown timed out; unfinished owners remain unconfirmed");
      finish(1);
    }, timeoutMs);
    stopping = Promise.resolve().then(async () => {
      // Startup can still be verifying a contract or binding the socket. Its
      // next checkpoint fences later producers; late ownership is drained too.
      await startup?.catch(() => undefined);
      const results = await Promise.all(drains.values());
      if (exited) return;
      const unknown = results.filter(Boolean);
      for (const { name, error: failure } of unknown) log.error("owner cleanup failed", { name, error: String(failure?.message || failure) });
      if (unknown.length) failed = true;
      // A rejected drain is not proof that work stopped. Never deliberately
      // close its database; the nonzero process exit remains the last boundary.
      if (!unknown.length) {
        try { await db.$disconnect(); }
        catch (failure) { failed = true; log.error("prisma disconnect failed", { error: String(failure?.message || failure) }); }
      }
      if (exited) return;
      cancel(deadline);
      finish(failed ? 1 : 0);
    });
    for (const [name, disposer] of owners) drain(name, disposer);
    return stopping;
  }
  const listeners = [
    ["SIGTERM", () => { void stop("SIGTERM"); }],
    ["SIGINT", () => { void stop("SIGINT"); }],
    ["uncaughtException", error => { void stop("uncaughtException", error); }],
    ["unhandledRejection", error => { void stop("unhandledRejection", error || new Error("Unhandled rejection")); }],
  ];
  for (const [name, handler] of listeners) processPort.on(name, handler);

  return {
    own, checkpoint, stop,
    getPhase: () => phase,
    middleware(_req, res, next) {
      if (phase !== "DRAINING" && phase !== "STOPPED") return next();
      res.setHeader("Connection", "close");
      res.setHeader("Retry-After", "1");
      return res.status(503).json({ ok: false, code: "BACKEND_STOPPING", error: "Backend is restarting" });
    },
    start(bootstrap) {
      if (startupResult) return startupResult;
      startup = Promise.resolve().then(async () => {
        checkpoint();
        await bootstrap({ own, checkpoint });
        checkpoint();
        phase = "RUNNING";
      });
      startupResult = startup.catch(error => stop("startup-failure", error));
      return startupResult;
    },
  };
}

module.exports = { createBackendProcessLifecycle };
