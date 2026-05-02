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

  // ─── Header actions ────────────────────────────────────────

  async function doImpersonate(agencyId) {
    const result = await A().impersonate(agencyId, {});
    if (!result?.ok) {
      R().toast(result?.error || "Impersonate failed");
      return;
    }
    window.open(result.url, "_blank", "noopener");
    R().toast(`impersonating ${result.target?.userEmail || "owner"}`);
  }

  async function doSoftDelete(agencyId) {
    const reason = prompt("Reason for deleting this agency? (saved to audit)") || "";
    if (reason === null) return; // user cancelled

    const really = confirm(
      "Soft-delete this agency?\n\n" +
      "It will be marked as deleted and locked. Members will be force-logged-out.\n" +
      "You can restore it later. No data is removed."
    );
    if (!really) return;

    const result = await A().deleteAgency(agencyId, { reason });
    if (!result?.ok) {
      R().toast(result?.error || "Delete failed");
      return;
    }
    R().toast("agency soft-deleted");
    await reloadDetail();
  }

  async function doRestore(agencyId) {
    if (!confirm("Restore this agency?\n\nStatus will go back to TRIAL — adjust subscription if needed.")) return;
    const result = await A().restoreAgency(agencyId, {});
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

    const result = await A().deleteAgency(agencyId, { hard: "1", reason });
    if (!result?.ok) {
      R().toast(result?.error || "Hard delete failed");
      return;
    }
    R().toast("agency hard-deleted — redirecting to list");
    setTimeout(() => R().pushSection("agencies"), 800);
  }

  // ─── Members ───────────────────────────────────────────────

  async function changeMemberRole(memberId, role, onError) {
    const result = await A().patchMemberRole(memberId, { role });
    if (!result?.ok) {
      R().toast(result?.error || "Role change failed");
      onError?.();
      return;
    }
    R().toast(`role changed to ${role.toLowerCase()}`);
    await reloadDetail();
  }

  async function kickMember(memberId) {
    const result = await A().deleteMember(memberId, { reason: "admin removed from console" });
    if (!result?.ok) {
      R().toast(result?.error || "Kick failed");
      return;
    }
    R().toast("member removed");
    await reloadDetail();
  }

  // ─── Creators ──────────────────────────────────────────────

  async function deleteCreator(creatorId) {
    const result = await A().deleteCreator(creatorId, { reason: "admin soft-delete from agency detail" });
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
    doImpersonate,
    doSoftDelete,
    doRestore,
    doHardDelete,
    changeMemberRole,
    kickMember,
    deleteCreator,
    saveSubscription,
  };
})();
