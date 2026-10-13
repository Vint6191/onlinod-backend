(function () {
  "use strict";
  const components = [
    ["coreValidUntil", "Core"],
    ["aiChatterValidUntil", "AI Chatter"],
    ["outreachValidUntil", "SFS / Outreach"],
  ];
  const value = (date) => (date ? new Date(date).toISOString().slice(0, 19) : "");
  function command(model, draft) {
    const ent = model.entitlement || {},
      reason = draft.reason.trim();
    if (!reason) throw Error("Enter a reason for the access change.");
    const body = { expectedRevision: ent.entitlementRevision || 0, reason };
    for (const [key] of components) {
      if (draft[key] === value(ent[key])) continue;
      const date = draft[key] ? new Date(draft[key] + "Z") : null;
      if (date && !Number.isFinite(date.getTime())) throw Error("Enter valid UTC dates.");
      body[key] = date ? date.toISOString() : null;
    }
    if (draft.tier !== (ent.tier || model.tier || "STARTER")) {
      body.tier = draft.tier;
      if (!Object.hasOwn(body, "coreValidUntil")) body.coreValidUntil = ent.coreValidUntil || null;
    }
    if (!components.some(([key]) => Object.hasOwn(body, key))) throw Error("No access dates or tier were changed.");
    return body;
  }
  function open(model, reload) {
    const W = window.NodAdminWorkspace,
      R = window.NodAdminRouter,
      esc = R.escapeHtml;
    document.querySelectorAll(".adm-modal-overlay").forEach((node) => node.remove());
    const overlay = document.createElement("div");
    overlay.className = "adm-modal-overlay";
    const ent = model.entitlement || {};
    overlay.innerHTML = `<form class="adm-modal" role="dialog" aria-modal="true" aria-label="Model access">
      <div class="adm-modal-head"><b>Access · ${esc(model.displayName || model.creatorId)}</b><button type="button" class="adm-btn" data-close>Close</button></div>
      <div class="adm-modal-body"><p>Dates are UTC. Clearing a date revokes that component. Untouched components keep their exact paid dates.</p>
      <label>Access tier<select class="adm-select" name="tier">${["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"].map((tier) => `<option ${tier === (ent.tier || model.tier || "STARTER") ? "selected" : ""}>${tier}</option>`).join("")}</select></label>
      ${components.map(([key, label]) => `<label class="adm-field">${label} access until (UTC)<input class="adm-input" type="datetime-local" step="1" name="${key}" value="${esc(value(ent[key]))}"></label>`).join("")}
      <label class="adm-field">Reason<input class="adm-input" name="reason" required maxlength="500"></label>
      <button class="adm-btn primary" type="submit">Save access</button><p role="status"></p></div></form>`;
    document.body.append(overlay);
    const form = overlay.querySelector("form"),
      status = form.querySelector('[role="status"]');
    form.querySelector("[data-close]").addEventListener("click", () => overlay.remove());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const draft = Object.fromEntries(new FormData(form));
      let body;
      try {
        body = command(model, draft);
      } catch (error) {
        status.textContent = error.message;
        return;
      }
      void W.action(form, async (current) => {
        const result = await window.NodAdminApi.patchCreatorEntitlement(model.creatorId, body);
        if (!current()) return;
        if (!result?.ok) {
          status.textContent = result?.error || "Result unknown. Check the saved command result.";
          return;
        }
        overlay.remove();
        R.toast("Access updated", "ok");
        await reload();
      });
    });
    form.querySelector('[name="reason"]').focus();
  }
  window.NodAdminEntitlements = { open, command, value };
})();
