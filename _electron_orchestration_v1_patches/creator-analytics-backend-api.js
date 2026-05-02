/* renderer/creator-analytics/creator-analytics-backend-api.js
   ────────────────────────────────────────────────────────────
   Thin wrapper for the new /api/stats/* endpoints.
   
   Drop in next to creator-analytics-events.js.
   Load BEFORE creator-analytics-events.js in your renderer.
   ────────────────────────────────────────────────────────────
*/

(function () {
  "use strict";

  function getActiveAgencyId() {
    const sess = window.OnlinodBackendSession;
    if (!sess) return null;
    if (typeof sess.getActiveAgencyId === "function") return sess.getActiveAgencyId();
    const ctx = sess.getContext?.() || sess.context || null;
    return (
      ctx?.activeAgencyId ||
      ctx?.activeAgency?.id ||
      sess.getSession?.()?.activeAgencyId ||
      null
    );
  }

  async function request(path, options = {}) {
    const bridge = window.desktopAPI?.backend;
    if (bridge?.request) return bridge.request(path, options);

    // Fallback fetch
    const token = await window.desktopAPI?.backend?.getAccessToken?.();
    const url = (window.OnlinodBackendBaseUrl || "https://onlinod-backend.onrender.com") + path;

    const res = await fetch(url, {
      method: options.method || "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const data = await res.json().catch(() => ({ ok: false, error: "Invalid JSON" }));
    if (!res.ok && !data.code) data.code = `HTTP_${res.status}`;
    return data;
  }


  async function getCreatorEarnings(creatorId, rangeKey) {
    return request(`/api/stats/creators/${encodeURIComponent(creatorId)}/earnings?range=${encodeURIComponent(rangeKey || "7d")}`);
  }

  async function getCreatorCampaigns(creatorId) {
    return request(`/api/stats/creators/${encodeURIComponent(creatorId)}/campaigns`);
  }

  async function getCreatorOverview(creatorId, rangeKey) {
    return request(`/api/stats/creators/${encodeURIComponent(creatorId)}/overview?range=${encodeURIComponent(rangeKey || "7d")}`);
  }

  async function getAgencyEarningsSummary(rangeKey) {
    const agencyId = getActiveAgencyId();
    if (!agencyId) return { ok: false, code: "NO_ACTIVE_AGENCY" };
    return request(`/api/stats/agencies/${encodeURIComponent(agencyId)}/earnings/summary?range=${encodeURIComponent(rangeKey || "7d")}`);
  }

  async function refreshCreator(creatorId, rangeKey) {
    return request(`/api/stats/creators/${encodeURIComponent(creatorId)}/refresh`, {
      method: "POST",
      body: { rangeKey: rangeKey || "7d" },
    });
  }

  async function refreshAgency(rangeKey) {
    const agencyId = getActiveAgencyId();
    if (!agencyId) return { ok: false, code: "NO_ACTIVE_AGENCY" };
    return request(`/api/stats/agencies/${encodeURIComponent(agencyId)}/refresh`, {
      method: "POST",
      body: { rangeKey: rangeKey || "7d" },
    });
  }

  async function listPendingJobs() {
    return request(`/api/jobs/pending`);
  }


  window.OnlinodCreatorAnalyticsBackendApi = {
    getCreatorEarnings,
    getCreatorCampaigns,
    getCreatorOverview,
    getAgencyEarningsSummary,
    refreshCreator,
    refreshAgency,
    listPendingJobs,
  };
})();
