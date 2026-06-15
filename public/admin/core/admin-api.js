/* public/admin/core/admin-api.js
   ────────────────────────────────────────────────────────────
   Thin wrapper around fetch() for the admin frontend.
   
   - Reads admin Bearer token from localStorage("onlinod_admin_token").
   - On 401, redirects to /admin-login (unless already there).
   - Always returns parsed JSON (or { ok: false, error } on parse fail).
   - Stashes the last request/response on window.OnlinodAdminState.lastDebug
     so we can inspect it in the system page later.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const TOKEN_KEY = "onlinod_admin_token";

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || "";
  }

  function setToken(token) {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  }

  function buildUrl(path, query) {
    if (!query) return path;

    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      params.append(k, String(v));
    }
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
  }

  async function request(path, options = {}) {
    const token = getToken();
    const url = buildUrl(path, options.query);

    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };
    if (token && options.auth !== false) {
      headers.Authorization = `Bearer ${token}`;
    }

    let res;
    try {
      res = await fetch(url, {
        method: options.method || "GET",
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      const errResult = { ok: false, code: "NETWORK", error: String(err?.message || err) };
      stashDebug({ url, method: options.method || "GET", body: options.body }, errResult);
      return errResult;
    }

    let data = null;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        data = await res.json();
      } catch (_) {
        data = { ok: false, code: "INVALID_JSON", error: "Server returned invalid JSON" };
      }
    } else {
      const text = await res.text();
      data = { ok: res.ok, text };
    }

    if (!res.ok && !data?.httpStatus) data.httpStatus = res.status;

    stashDebug({ url, method: options.method || "GET", body: options.body }, data);

    if (res.status === 401 && options.auth !== false) {
      // Admin session is dead. Drop token and redirect to login,
      // unless we ARE on the login page already.
      setToken(null);
      if (!location.pathname.startsWith("/admin-login")) {
        history.pushState({}, "", "/admin-login");
        window.OnlinodAdminRouter?.render?.();
      }
    }

    return data;
  }

  function stashDebug(req, res) {
    if (!window.OnlinodAdminState) return;
    window.OnlinodAdminState.lastDebug = { request: req, response: res, at: new Date().toISOString() };
  }

  // ─── Convenience wrappers around our admin endpoints ─────────
  //
  // Each method maps 1:1 to a backend route. Keeping this thin:
  // pages call api.something() instead of remembering URL paths.

  const api = {
    TOKEN_KEY,
    getToken, setToken, request,

    // auth
    login:  (body)   => request("/api/admin-auth/login",  { method: "POST", body, auth: false }),
    me:     ()       => request("/api/admin-auth/me"),
    logout: ()       => request("/api/admin-auth/logout", { method: "POST" }),

    // dashboard / system
    dashboard:    ()       => request("/api/admin/dashboard"),
    systemHealth: ()       => request("/api/admin/system/health"),
    retentionSettings: ()  => request("/api/admin/system/retention"),
    saveRetentionSettings: (body) => request("/api/admin/system/retention", { method: "PATCH", body }),
    resetRetentionSettings: () => request("/api/admin/system/retention/reset", { method: "POST" }),
    runRetentionSweep: ()  => request("/api/admin/system/retention/run", { method: "POST" }),
    plans:        ()       => request("/api/admin/plans"),

    // agencies
    listAgencies:    (query) => request("/api/admin/agencies", { query }),
    getAgency:       (id)    => request(`/api/admin/agencies/${encodeURIComponent(id)}`),
    patchAgency:     (id, body) => request(`/api/admin/agencies/${encodeURIComponent(id)}`,         { method: "PATCH",  body }),
    deleteAgency:    (id, query) => request(`/api/admin/agencies/${encodeURIComponent(id)}`,        { method: "DELETE", query }),
    restoreAgency:   (id, body) => request(`/api/admin/agencies/${encodeURIComponent(id)}/restore`, { method: "POST",   body }),
    impersonate:     (id, body) => request(`/api/admin/agencies/${encodeURIComponent(id)}/impersonate`, { method: "POST", body }),
    patchSubscription: (id, body) => request(`/api/admin/agencies/${encodeURIComponent(id)}/subscription`, { method: "PATCH", body }),

    // members
    listMembers:    (agencyId) => request(`/api/admin/agencies/${encodeURIComponent(agencyId)}/members`),
    patchMemberRole:(memberId, body) => request(`/api/admin/members/${encodeURIComponent(memberId)}/role`, { method: "PATCH", body }),
    patchMemberPerms:(memberId, body) => request(`/api/admin/members/${encodeURIComponent(memberId)}/permissions`, { method: "PATCH", body }),
    deleteMember:   (memberId, query) => request(`/api/admin/members/${encodeURIComponent(memberId)}`, { method: "DELETE", query }),

    // users
    listUsers:      (query) => request("/api/admin/users", { query }),
    getUser:        (id)    => request(`/api/admin/users/${encodeURIComponent(id)}`),
    patchUser:      (id, body) => request(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    forceLogout:    (id, body) => request(`/api/admin/users/${encodeURIComponent(id)}/force-logout`, { method: "POST", body }),
    resetUserPwd:   (id, body) => request(`/api/admin/users/${encodeURIComponent(id)}/reset-password`, { method: "POST", body }),

    // creators
    listCreators: (query) => request("/api/admin/creators", { query }),
    patchCreatorStatus:  (id, body) => request(`/api/admin/creators/${encodeURIComponent(id)}/status`,  { method: "PATCH",  body }),
    patchCreatorBilling: (id, body) => request(`/api/admin/creators/${encodeURIComponent(id)}/billing`, { method: "PATCH",  body }),
    deleteCreator:       (id, query) => request(`/api/admin/creators/${encodeURIComponent(id)}`,        { method: "DELETE", query }),

    // devices
    listDevices: (query) => request("/api/admin/devices", { query }),
    kickDevice:  (id, body) => request(`/api/admin/devices/${encodeURIComponent(id)}/kick`, { method: "POST", body }),

    // audit
    audit: (query) => request("/api/admin/audit", { query }),
    liveFeed: (query) => request("/api/admin/live-feed", { query }),

    // admin users
    listAdminUsers:   () => request("/api/admin/admin-users"),
    createAdminUser:  (body) => request("/api/admin/admin-users", { method: "POST", body }),
    patchAdminUser:   (id, body) => request(`/api/admin/admin-users/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    resetAdminPwd:    (id, body) => request(`/api/admin/admin-users/${encodeURIComponent(id)}/reset-password`, { method: "POST", body }),

    // ─── deep data explorer (admin-data.js) ───────────────────
    dataSearch:        (q)      => request("/api/admin/data/search", { query: { q } }),
    dataAnomalies:     ()       => request("/api/admin/data/anomalies"),
    creatorOverview:   (id)     => request(`/api/admin/data/creator/${encodeURIComponent(id)}/overview`),
    crmProfiles:       (query)  => request("/api/admin/data/crm-profiles", { query }),
    crmProfile:        (id)     => request(`/api/admin/data/crm-profiles/${encodeURIComponent(id)}`),
    crmTags:           (query)  => request("/api/admin/data/crm-tags", { query }),
    crmNotes:          (query)  => request("/api/admin/data/crm-notes", { query }),
    dataDeliveries:    (query)  => request("/api/admin/data/deliveries", { query }),
    dataBumpStats:     (query)  => request("/api/admin/data/bump-stats", { query }),
    dataHiddenOnline:  (query)  => request("/api/admin/data/hidden-online", { query }),
    dataFollowBack:    (query)  => request("/api/admin/data/follow-back", { query }),
    dataVaultSales:    (query)  => request("/api/admin/data/vault-sales", { query }),
    dataVaultPurch:    (query)  => request("/api/admin/data/vault-purchases", { query }),
    dataMoney:         (query)  => request("/api/admin/data/money", { query }),
    dataContent:       (query)  => request("/api/admin/data/content", { query }),
    dataInspect:       (model, id) => request(`/api/admin/data/inspect/${encodeURIComponent(model)}/${encodeURIComponent(id)}`),
    dataDeleteRecord:  (model, id, query) => request(`/api/admin/data/record/${encodeURIComponent(model)}/${encodeURIComponent(id)}`, { method: "DELETE", query }),
    dataBulkDelete:    (body)   => request("/api/admin/data/bulk-delete", { method: "POST", body }),
    dataPurgeDeliveries:(body)  => request("/api/admin/data/purge-deliveries", { method: "POST", body }),

    // ─── billing management (admin-billing.js) ────────────────
    billingOverview:   ()       => request("/api/admin/billing/overview"),
    billingAgency:     (id)     => request(`/api/admin/billing/agency/${encodeURIComponent(id)}`),
    billingTiers:      ()       => request("/api/admin/billing/tiers"),
    billingSetCreator: (id, body) => request(`/api/admin/billing/creator/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    billingApplyTier:  (id, body) => request(`/api/admin/billing/agency/${encodeURIComponent(id)}/apply-tier`, { method: "POST", body }),
  };

  window.OnlinodAdminApi = api;
})();
