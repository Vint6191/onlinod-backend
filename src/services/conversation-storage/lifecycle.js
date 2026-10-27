"use strict";

// Register ownership synchronously, before starting any asynchronous work.
// Domain outages suspend their relay, not the core product HTTP listener.
function startConversationStores({ stores, own, log, schedule = setTimeout, cancel = clearTimeout }) {
  let stopped = false;
  let timer;
  let running;
  let closing;
  let lastErrorAt = -Infinity;
  const knownHealth = new Map();
  const stop = () => {
    if (closing) return closing;
    stopped = true;
    if (timer) cancel(timer);
    // The process lifecycle disconnects databases after ALL producers and HTTP
    // requests drain. Stopping this relay alone does not establish that boundary.
    closing = Promise.resolve(running);
    return closing;
  };
  own("conversation-stores", stop);
  const tick = () => {
    if (stopped) return;
    let retryMs = 5000;
    running = (async () => {
      const domains = ["dialogs", "crm"];
      const health = await Promise.allSettled(domains.map((domain) => stores.check(domain)));
      for (const [i, result] of health.entries()) {
        const state = result.status === "fulfilled" ? "ready" : result.reason?.code || "DATABASE_UNAVAILABLE";
        if (knownHealth.get(domains[i]) !== state) {
          knownHealth.set(domains[i], state);
          const details = { domain: domains[i], code: state };
          if (state === "ready") log.info("conversation store ready", details);
          else log.warn("conversation store unavailable", details);
        }
      }
      if (health.some((r) => r.status === "rejected")) {
        retryMs = 30000;
        return;
      }
      if (!stopped) await stores.pump();
    })()
      .catch((error) => {
        retryMs = 30000;
        if (Date.now() - lastErrorAt > 60000) {
          lastErrorAt = Date.now();
          log.warn("conversation history relay delayed", { code: error.code || "CONVERSATION_RELAY_FAILED" });
        }
      })
      .finally(() => {
        if (!stopped) {
          timer = schedule(tick, retryMs);
          timer?.unref?.();
        }
      });
  };
  tick();
  return stop;
}

module.exports = { startConversationStores };
