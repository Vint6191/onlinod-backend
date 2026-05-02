/* renderer/team-analytics/team-analytics-api.js
   ────────────────────────────────────────────────────────────
   Thin wrapper around the new /api/team and /api/invitations
   endpoints. The state module (team-analytics-state.js) reaches
   into this file when persisting/loading.
   
   Drop this file next to team-analytics-state.js and load it
   BEFORE team-analytics-state.js in your renderer index.html.
   
   This file uses window.desktopAPI.backend.request() — your
   existing IPC bridge for authenticated backend calls. If your
   bridge name differs, adjust the fetch helper at the top.
   ────────────────────────────────────────────────────────────
*/

(function () {
  "use strict";

  function getActiveAgencyId() {
    // OnlinodBackendSession is populated by auth-login-events.js
    // after login. It should expose getActiveAgencyId() or hold
    // the active agency in its session/context blob.
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

  // Use the existing desktopAPI bridge that auth-login-api.js uses.
  // We assume it has a generic request() method; if not, we fall back
  // to fetch() with a manually-attached access token.
  async function request(path, options = {}) {
    const bridge = window.desktopAPI?.backend;
    if (bridge?.request) {
      return bridge.request(path, options);
    }

    // Fallback — direct fetch. Requires window.desktopAPI.backend.getAccessToken().
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


  async function fetchTeamState() {
    const agencyId = getActiveAgencyId();
    if (!agencyId) return { ok: false, code: "NO_ACTIVE_AGENCY" };
    return request(`/api/team/state?agencyId=${encodeURIComponent(agencyId)}`);
  }

  async function patchRoleAccess(roleKey, zoneKey, levelKey) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/roles/${encodeURIComponent(roleKey)}/access`, {
      method: "PATCH",
      body: { agencyId, zoneKey, levelKey },
    });
  }

  async function resetRoleOverrides(roleKey) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/roles/${encodeURIComponent(roleKey)}/reset`, {
      method: "POST",
      body: { agencyId },
    });
  }

  async function duplicateRole({ sourceKey, newLabel, sourceAccess, tone }) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/roles/duplicate`, {
      method: "POST",
      body: { agencyId, sourceKey, newLabel, sourceAccess, tone },
    });
  }

  async function deleteCustomRole(roleKey) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/roles/${encodeURIComponent(roleKey)}?agencyId=${encodeURIComponent(agencyId)}`, {
      method: "DELETE",
    });
  }

  async function setSubPermissionOverride(roleKey, subPermKey, value) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/roles/${encodeURIComponent(roleKey)}/sub/${encodeURIComponent(subPermKey)}`, {
      method: "PATCH",
      body: { agencyId, value }, // value: true | false | null (null = clear override)
    });
  }


  async function patchMember(memberId, patch) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/members/${encodeURIComponent(memberId)}`, {
      method: "PATCH",
      body: { agencyId, ...patch },
    });
  }

  async function deleteMember(memberId) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/members/${encodeURIComponent(memberId)}?agencyId=${encodeURIComponent(agencyId)}`, {
      method: "DELETE",
    });
  }

  async function setMemberRole(memberId, roleKey) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/members/${encodeURIComponent(memberId)}/role`, {
      method: "PATCH",
      body: { agencyId, roleKey },
    });
  }


  async function createInvitation({ email, roleKey, displayName, assignedCreators, commission, expiresInDays }) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/invitations`, {
      method: "POST",
      body: { agencyId, email, roleKey, displayName, assignedCreators, commission, expiresInDays },
    });
  }

  async function listInvitations({ includeExpired = false } = {}) {
    const agencyId = getActiveAgencyId();
    const qs = `agencyId=${encodeURIComponent(agencyId)}${includeExpired ? "&includeExpired=1" : ""}`;
    return request(`/api/team/invitations?${qs}`);
  }

  async function revokeInvitation(invitationId) {
    const agencyId = getActiveAgencyId();
    return request(`/api/team/invitations/${encodeURIComponent(invitationId)}?agencyId=${encodeURIComponent(agencyId)}`, {
      method: "DELETE",
    });
  }


  window.OnlinodTeamAnalyticsApi = {
    getActiveAgencyId,
    // state
    fetchTeamState,
    // roles
    patchRoleAccess,
    resetRoleOverrides,
    duplicateRole,
    deleteCustomRole,
    setSubPermissionOverride,
    // members
    patchMember,
    deleteMember,
    setMemberRole,
    // invitations
    createInvitation,
    listInvitations,
    revokeInvitation,
  };
})();
