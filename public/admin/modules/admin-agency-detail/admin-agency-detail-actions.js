/* public/admin/modules/admin-agency-detail/admin-agency-detail-actions.js
   ────────────────────────────────────────────────────────────
   All mutating operations called from agency detail. Each one:
     1. Asks the backend.
     2. Toasts result (success/failure).
     3. Reloads the slice via OnlinodAdminAgencyDetail.load(true)
        so the UI reflects new data.
   
   We pass error-recovery callbacks where the UI needs to
   visually revert (e.g. role select on backend rejection).
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;

  function reloadDetail() {
    return window.OnlinodAdminAgencyDetail.load(true);
  }

  function shownAgency() {
    const id = window.OnlinodAdminState.sectionParam;
    return window.OnlinodAdminStateApi.ensureAgencyDetail(id).data?.agency;
  }
  function shownMember(id) { return shownAgency()?.members?.find(m => m.id === id); }
  function reasonForAction(label) { const value = prompt(label); return value?.trim() || null; }

  // ─── Header actions ────────────────────────────────────────

  async function doSupport(agencyId) {
    return window.OnlinodAdminSupport.open(agencyId);
  }

  async function doSoftDelete(agencyId) {
    const reason = reasonForAction("Reason for deleting this agency? (required)");
    if (!reason) return;

    const really = confirm(
      "Soft-delete this agency?\n\n" +
      "It will be marked as deleted and locked. Members will be force-logged-out.\n" +
      "You can restore it later. No data is removed."
    );
    if (!really) return;

    const result = await A().deleteAgency(agencyId, { reason, expectedUpdatedAt: shownAgency()?.updatedAt, hard: false });
    if (!result?.ok) {
      R().toast(result?.error || "Delete failed");
      return;
    }
    R().toast("agency soft-deleted");
    await reloadDetail();
  }

  async function doRestore(agencyId) {
    if (!confirm("Restore this agency?\n\nAccess will be recalculated from current billing entitlements.")) return;
    const reason = reasonForAction("Reason for restoring this agency?"); if (!reason) return;
    const result = await A().restoreAgency(agencyId, { reason, expectedUpdatedAt: shownAgency()?.updatedAt });
    if (!result?.ok) {
      R().toast(result?.error || "Restore failed");
      return;
    }
    R().toast("agency restored");
    await reloadDetail();
  }

  async function doHardDelete(agencyId) {
    const confirmText = prompt(
      "HARD DELETE — this is irreversible.\n\n" +
      "All members, creators, snapshots, billing history will be removed.\n" +
      "Type 'DELETE' to confirm:"
    );
    if (confirmText !== "DELETE") {
      R().toast("hard delete cancelled");
      return;
    }
    const reason = prompt("Reason (saved to audit) — required for hard delete:") || "";
    if (!reason.trim()) {
      R().toast("reason required");
      return;
    }

    const result = await A().deleteAgency(agencyId, { hard: true, reason, expectedUpdatedAt: shownAgency()?.updatedAt });
    if (!result?.ok) {
      R().toast(result?.error || "Hard delete failed");
      return;
    }
    R().toast(result?.pending ? "agency hard-delete scheduled — cleanup is running" : "agency hard-deleted");
    setTimeout(() => R().pushSection("agencies"), 800);
  }

  // ─── Members ───────────────────────────────────────────────

  async function changeMemberRole(memberId, role, onError) {
    const reason = reasonForAction("Reason for changing member role?"); if (!reason) { onError?.(); return; }
    const member = shownMember(memberId);
    const result = await A().patchMemberRole(memberId, { role, reason, agencyId: shownAgency()?.id, expectedAccessEpoch: member?.accessEpoch });
    if (!result?.ok) {
      R().toast(result?.error || "Role change failed");
      onError?.();
      return;
    }
    R().toast(`role changed to ${role.toLowerCase()}`);
    await reloadDetail();
  }

  async function kickMember(memberId) {
    const reason = reasonForAction("Reason for removing this member?"); if (!reason) return;
    const member = shownMember(memberId);
    const result = await A().deleteMember(memberId, { reason, agencyId: shownAgency()?.id, expectedAccessEpoch: member?.accessEpoch });
    if (!result?.ok) {
      R().toast(result?.error || "Kick failed");
      return;
    }
    R().toast("member removed");
    await reloadDetail();
  }

  // ─── Creators ──────────────────────────────────────────────

  async function deleteCreator(creatorId) {
    const reason = reasonForAction("Reason for removing this creator?"); if (!reason) return;
    const creator = shownAgency()?.creators?.find(c => c.id === creatorId);
    const result = await A().deleteCreator(creatorId, { reason, agencyId: shownAgency()?.id, expectedUpdatedAt: creator?.updatedAt, hard: false });
    if (!result?.ok) {
      R().toast(result?.error || "Delete failed");
      return;
    }
    R().toast("creator soft-deleted");
    await reloadDetail();
  }

  // ─── Subscription ──────────────────────────────────────────

  async function saveSubscription(agencyId, body) {
    const result = await A().patchSubscription(agencyId, body);
    if (!result?.ok) {
      R().toast(result?.error || "Subscription save failed");
      return;
    }
    R().toast("subscription saved");
    await reloadDetail();
  }

  window.OnlinodAdminAgencyDetailActions = {
    reloadDetail,
    doSupport,
    doSoftDelete,
    doRestore,
    doHardDelete,
    changeMemberRole,
    kickMember,
    deleteCreator,
    saveSubscription,
  };
})();
