
/* modules/online-users/renderer/online-users-backend-api.js
   Frontend helper for backend-driven online presence.
*/
(function () {
  "use strict";

  async function request(path, options = {}) {
    const bridge = window.desktopAPI?.backend;
    if (bridge?.request) return bridge.request(path, options);
    return { ok: false, code: "BACKEND_BRIDGE_MISSING", error: "desktopAPI.backend.request is missing" };
  }

  async function getCreatorPresence(creatorId, options = {}) {
    const q = new URLSearchParams();
    q.set("status", options.status || "visible");
    q.set("limit", String(options.limit || 500));
    return request(`/api/presence/creators/${encodeURIComponent(creatorId)}?${q.toString()}`);
  }

  async function queueRefresh(creatorId, reason = "manual_presence_refresh") {
    return request(`/api/presence/creators/${encodeURIComponent(creatorId)}/refresh`, {
      method: "POST",
      body: { reason },
    });
  }

  async function pushEvents(creatorId, { deviceId, events }) {
    return request(`/api/presence/creators/${encodeURIComponent(creatorId)}/events`, {
      method: "POST",
      body: { deviceId, events: Array.isArray(events) ? events : [] },
    });
  }

  async function pushSnapshot(creatorId, { deviceId, users, capturedAt, source = "api_snapshot" }) {
    return request(`/api/presence/creators/${encodeURIComponent(creatorId)}/snapshot`, {
      method: "POST",
      body: { deviceId, users: Array.isArray(users) ? users : [], capturedAt, source },
    });
  }

  window.OnlinodOnlineUsersBackendApi = { getCreatorPresence, queueRefresh, pushEvents, pushSnapshot };
})();
