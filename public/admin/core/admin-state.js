/* public/admin/core/admin-state.js
   ────────────────────────────────────────────────────────────
   v3 (заход 4): adds users, creators, devices slices.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const initial = () => ({
    admin: null,
    section: "dashboard",
    sectionParam: null,

    // ── slices ────────────────────────────────────────────
    dashboard: {
      loading: false, error: null, data: null, lastLoadedAt: 0,
    },
    agencies: {
      loading: false, error: null, list: [],
      filters: { q: "", includeDeleted: false, statusFilter: "all" },
      lastLoadedAt: 0,
    },
    agencyDetail: {},

    // Cross-agency listings — one slice per section.
    users: {
      loading: false, error: null, list: [],
      filters: { q: "", unverified: false, no_agency: false, disabled: false },
      lastLoadedAt: 0,
    },
    creators: {
      loading: false, error: null, list: [],
      filters: { q: "", status: "", tier: "", agencyId: "", no_canonical: false },
      lastLoadedAt: 0,
    },
    devices: {
      loading: false, error: null, list: [],
      filters: { q: "", agencyId: "", online: false, offline: false },
      lastLoadedAt: 0,
    },

    lastDebug: null,
  });
  const state = initial();

  function setAdmin(admin) {
    state.admin = admin || null;
    if (admin) localStorage.setItem("onlinod_admin", JSON.stringify(admin));
    else localStorage.removeItem("onlinod_admin");
  }

  function clearSession() {
    window.OnlinodAdminApi.setToken(null);
    reset();
  }

  function reset() {
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, initial());
    localStorage.removeItem("onlinod_admin");
  }
  window.addEventListener("onlinod:admin-session-changed", reset);
  window.addEventListener("storage", event => { if (event.key === "onlinod_admin_token" || event.key === null) reset(); });

  function setSection(section, param) {
    state.section = section || "dashboard";
    state.sectionParam = param || null;
  }

  function ensureAgencyDetail(id) {
    if (!id) return null;
    if (!state.agencyDetail[id]) {
      state.agencyDetail[id] = {
        loading: false, error: null, data: null,
        tab: "overview",
        lastLoadedAt: 0,
        ui: { editingMember: null, editingSubscription: false },
      };
    }
    return state.agencyDetail[id];
  }

  window.OnlinodAdminState = state;
  window.OnlinodAdminSession = { setAdmin, clearSession };
  window.OnlinodAdminStateApi = { setSection, ensureAgencyDetail };
})();
