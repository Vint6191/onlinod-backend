/* public/admin/core/admin-state.js
   ────────────────────────────────────────────────────────────
   v3 (заход 4): adds users, creators, devices slices.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const state = {
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
      filters: { q: "", status: "", tier: "", agencyId: "", no_snapshot: false },
      lastLoadedAt: 0,
    },
    devices: {
      loading: false, error: null, list: [],
      filters: { q: "", agencyId: "", online: false, offline: false },
      lastLoadedAt: 0,
    },

    lastDebug: null,
  };

  try {
    const cached = localStorage.getItem("onlinod_admin");
    if (cached) state.admin = JSON.parse(cached);
  } catch (_) { /* ignore */ }

  function setAdmin(admin) {
    state.admin = admin || null;
    if (admin) localStorage.setItem("onlinod_admin", JSON.stringify(admin));
    else localStorage.removeItem("onlinod_admin");
  }

  function clearSession() {
    state.admin = null;
    state.dashboard.data = null;
    state.agencies.list = [];
    state.agencyDetail = {};
    state.users.list = [];
    state.creators.list = [];
    state.devices.list = [];
    localStorage.removeItem("onlinod_admin");
    localStorage.removeItem("onlinod_admin_token");
  }

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
