(function () {
  "use strict";
  const API = () => window.OnlinodAdminApi;
  const esc = value => window.OnlinodAdminRouter.escapeHtml(value);
  const path = "/api/admin/billing/commercial-policy";
  const fields = [["trialDays", "Trial duration, days"], ["starterPriceCents", "Starter, USD / month"],
    ["growthPriceCents", "Growth, USD / month"], ["proPriceCents", "Pro, USD / month"],
    ["elitePriceCents", "Elite, USD / month"], ["aiChatterPriceCents", "AI Chatter, USD / month"],
    ["outreachPriceCents", "Outreach, USD / month"]];
  let generation = 0, activeRoot = null;
  function invalidate() { generation++; if (activeRoot) activeRoot.innerHTML = ""; activeRoot = null; }
  window.addEventListener("onlinod:admin-session-changed", invalidate);
  window.addEventListener("storage", event => { if (event.key === "onlinod_admin_token") invalidate(); });
  function parseDraft(root, revision) {
    const settings = {};
    for (const [key] of fields) {
      const raw = root.querySelector(`[name="${key}"]`).value.trim();
      const days = key === "trialDays";
      if (!(days ? /^\d+$/ : /^\d+(?:\.\d{1,2})?$/).test(raw)) throw new Error("Enter whole days and prices with at most two decimal places.");
      const value = days ? Number(raw) : Math.round(Number(raw) * 100);
      const min = ["aiChatterPriceCents", "outreachPriceCents"].includes(key) ? 0 : 1;
      if (!Number.isSafeInteger(value) || value < min || value > (days ? 365 : 1000000)) throw new Error("Trial: 1–365 days. Tier price: $0.01–$10,000; add-ons may be free.");
      settings[key] = value;
    }
    const reason = root.querySelector('[name="reason"]').value.trim();
    if (!reason || reason.length > 500) throw new Error("Enter a reason (1–500 characters).");
    return { expectedRevision: revision, settings, reason };
  }
  async function render(root) {
    if (!root) return;
    activeRoot = root;
    const own = ++generation, token = API().getToken();
    const current = () => own === generation && token === API().getToken() && root.isConnected !== false;
    root.innerHTML = '<div class="adm-card">Loading global billing settings…</div>';
    let key, saved;
    try {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      key = "onlinod_commercial_intent:" + Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, "0")).join("");
      try { saved = JSON.parse(sessionStorage.getItem(key) || "null"); } catch (_) {}
      const policy = await API().commercialPolicy();
      if (!current()) return;
      if (!policy?.ok) throw new Error(policy?.error || "Global billing settings unavailable");
      const draft = saved || { settings: policy.settings, expectedRevision: policy.revision, reason: "" };
      root.innerHTML = `<form class="adm-card" id="blPolicyForm">
        <h2>Global trial and prices</h2>
        <p>Trial duration applies to new agencies. Prices apply to future purchases and renewals for models using global prices. Existing trial deadlines, paid periods and individual overrides are preserved.</p>
        <div class="adm-muted">Revision ${esc(draft.expectedRevision)} · changes require SUPER_ADMIN</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:12px 0">
        ${fields.map(([name, label]) => `<label>${esc(label)}<input class="adm-input" name="${name}" type="number" required min="${name === "trialDays" ? 1 : name === "aiChatterPriceCents" || name === "outreachPriceCents" ? 0 : 0.01}" max="${name === "trialDays" ? 365 : 10000}" step="${name === "trialDays" ? 1 : 0.01}" value="${esc(name === "trialDays" ? draft.settings[name] : (draft.settings[name] / 100).toFixed(2))}"></label>`).join("")}
        </div>
        <label>Reason<input class="adm-input" name="reason" required maxlength="500" value="${esc(draft.reason)}"></label>
        <button class="adm-btn" type="submit">Save global settings</button>
        <button class="adm-btn" id="blPolicyCheck" type="button">Check result</button>
        <button class="adm-btn" id="blPolicyReload" type="button">Reload current settings</button>
        <p id="blPolicyStatus" role="status"></p>
      </form>`;
      const status = root.querySelector("#blPolicyStatus"), form = root.querySelector("#blPolicyForm");
      let pending = saved, busy = false;
      const lock = value => form.querySelectorAll("input").forEach(input => { input.disabled = value; });
      const remember = value => { pending = value; try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch (_) {} };
      async function check() {
        const result = await API().resolveCommand(path, "PATCH");
        if (!current()) return false;
        if (result.pending) { status.textContent = "Result is not confirmed. Retry the saved change or check again."; return false; }
        remember(null); return true;
      }
      if (pending) { lock(true); status.textContent = "A saved change needs confirmation. Save retries the same intent."; }
      form.addEventListener("submit", async event => {
        event.preventDefault(); if (busy) return;
        let body;
        try { body = pending || parseDraft(root, draft.expectedRevision); } catch (error) { status.textContent = error.message; return; }
        busy = true; remember(body); lock(true);
        status.textContent = "Saving…";
        try {
          const result = await API().saveCommercialPolicy(body);
          if (!current()) return;
          if (result?.ok) { remember(null); await render(root); if (activeRoot === root) root.querySelector("#blPolicyStatus").textContent = "Global settings saved."; }
          else if (result?.commandId && result.httpStatus < 500 && result.code !== "ADMIN_COMMAND_UNRESOLVED") { remember(null); lock(false); status.textContent = result.error || "Change rejected. Reload current settings."; }
          else { status.textContent = result?.error || "Result unknown. Retry this saved change or check its result."; }
        } catch (_) { if (current()) status.textContent = "Result unknown. Retry this saved change or check its result."; }
        finally { busy = false; }
      });
      root.querySelector("#blPolicyCheck").addEventListener("click", async () => { if (busy) return; try { if (await check()) await render(root); } catch (_) { if (current()) status.textContent = "Result unavailable; check again."; } });
      root.querySelector("#blPolicyReload").addEventListener("click", async () => { if (busy) return; try { if (!pending || await check()) await render(root); } catch (_) { if (current()) status.textContent = "Result unavailable; check again."; } });
    } catch (error) {
      if (current()) root.innerHTML = `<div class="adm-card"><p>${esc(error.message)}</p><button class="adm-btn" id="blPolicyRetry">Retry</button></div>`;
      root.querySelector("#blPolicyRetry")?.addEventListener("click", () => render(root));
    }
  }
  window.OnlinodAdminCommercialPolicy = { render };
})();
