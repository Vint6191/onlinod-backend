/* public/admin/modules/admin-billing/admin-billing.js
   ────────────────────────────────────────────────────────────
   Billing management. Subscription lives on the agency, priced
   per connected model. Two views:
     overview        — real MRR (status-filtered) + agency rollup
     agency detail   — every model with editable tier/price/addons,
                       live line totals, bulk "apply tier to all"
   Routed via section "billing" (overview) and a local detail state.
   ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;
  const esc = (v) => R().escapeHtml(v);
  const money = (c) => "$" + (Number(c || 0) / 100).toFixed(2);

  const local = { view: "overview", agencyId: null, tiers: null };

  async function render(main) {
    if (local.view === "agency" && local.agencyId) return renderAgency(main, local.agencyId);
    return renderOverview(main);
  }

  // ── OVERVIEW ────────────────────────────────────────────────
  async function renderOverview(main) {
    main.innerHTML = `<div class="adm-page"><div class="adm-loading">loading billing…</div></div>`;
    const r = await A().billingOverview();
    if (!r || !r.ok) { main.innerHTML = `<div class="adm-page"><div class="adm-error">failed to load billing</div></div>`; return; }

    const m = r.mrr || {};
    const kpis = [
      { label: "MRR (billed)", val: money(m.billedCents), strong: true },
      { label: "Billed models", val: m.billedModels },
      { label: "Billable agencies", val: `${m.billableAgencies} / ${m.totalAgencies}` },
      { label: "Trial potential", val: money(m.trialPotentialCents) },
    ].map((k) => `<div class="adm-kpi ${k.strong ? "adm-kpi-strong" : ""}"><div class="adm-kpi-label">${esc(k.label)}</div><div class="adm-kpi-val">${esc(k.val)}</div></div>`).join("");

    const rows = (r.agencies || []).map((a) => `
      <tr data-agency="${esc(a.agencyId)}" class="adm-clickable">
        <td><b>${esc(a.name)}</b><div class="adm-muted">${esc(a.plan || "")}</div></td>
        <td><span class="adm-badge adm-badge-${a.billable ? "ok" : (a.status === "TRIAL" ? "info" : "muted")}">${esc(a.status)}</span></td>
        <td>${esc(a.modelsBilled)} / ${esc(a.modelsTotal)}</td>
        <td class="adm-money">${money(a.monthlyCents)}</td>
        <td class="adm-muted">${a.addons.aiChatter ? "AI " + money(a.addons.aiChatter) : ""} ${a.addons.outreach ? "OR " + money(a.addons.outreach) : ""}</td>
        <td class="adm-muted">${a.currentPeriodEnd ? esc(String(a.currentPeriodEnd).slice(0, 10)) : (a.trialEndsAt ? "trial→" + esc(String(a.trialEndsAt).slice(0, 10)) : "—")}</td>
      </tr>`).join("");

    main.innerHTML = `
      <div class="adm-page">
        <div class="adm-page-head">
          <h1>Billing</h1>
          <div class="adm-page-sub">subscription is per agency, priced per connected model</div>
        </div>
        <div class="adm-kpi-row">${kpis}</div>
        <div class="adm-card">
          <div class="adm-card-title">Agencies — monthly billing (click to manage)</div>
          <table class="adm-table">
            <thead><tr><th>Agency</th><th>Status</th><th>Models billed</th><th>Monthly</th><th>Addons</th><th>Period end</th></tr></thead>
            <tbody>${rows || `<tr><td colspan="6" class="adm-muted">no agencies</td></tr>`}</tbody>
          </table>
        </div>
        <div class="adm-muted">MRR counts only billable statuses (ACTIVE / PAST_DUE / GRACE). Trial = potential, not yet charged.</div>
      </div>`;

    main.querySelectorAll("tr[data-agency]").forEach((tr) => tr.addEventListener("click", () => {
      local.view = "agency"; local.agencyId = tr.dataset.agency; render(main);
    }));
  }

  // ── AGENCY DETAIL (per-model editor) ────────────────────────
  async function renderAgency(main, agencyId) {
    main.innerHTML = `<div class="adm-page"><div class="adm-loading">loading agency billing…</div></div>`;
    const r = await A().billingAgency(agencyId);
    if (!r || !r.ok) { main.innerHTML = `<div class="adm-page"><div class="adm-error">failed</div></div>`; return; }
    local.tiers = r.tiers || {};

    const tierOpts = (sel) => Object.entries(r.tiers).map(([k, v]) =>
      `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v.label)} (${money(v.priceCents)})</option>`).join("");

    const rows = (r.models || []).map((m) => `
      <tr data-creator="${esc(m.creatorId)}" class="${m.billingExcluded ? "adm-row-excluded" : ""}">
        <td>
          <b>${esc(m.displayName || m.username || m.creatorId.slice(-8))}</b>
          <div class="adm-muted">@${esc(m.username || "—")} · ${esc(m.creatorStatus || "")}</div>
        </td>
        <td><select class="bl-tier">${tierOpts(m.tier || "STARTER")}</select></td>
        <td><input class="bl-price" type="number" min="0" step="1" value="${(Number(m.corePriceCents || 0) / 100).toFixed(0)}" style="width:80px"> </td>
        <td class="adm-addon-cell">
          <label><input type="checkbox" class="bl-ai" ${m.aiChatterEnabled ? "checked" : ""}> AI</label>
          <input class="bl-ai-price" type="number" min="0" value="${(Number(m.aiChatterPriceCents || 0) / 100).toFixed(0)}" style="width:64px">
        </td>
        <td class="adm-addon-cell">
          <label><input type="checkbox" class="bl-or" ${m.outreachEnabled ? "checked" : ""}> OR</label>
          <input class="bl-or-price" type="number" min="0" value="${(Number(m.outreachPriceCents || 0) / 100).toFixed(0)}" style="width:64px">
        </td>
        <td><label><input type="checkbox" class="bl-excl" ${m.billingExcluded ? "checked" : ""}> excl</label></td>
        <td class="adm-money bl-line">${money(m.lineCents)}</td>
        <td><button class="adm-btn adm-btn-sm bl-save">save</button></td>
      </tr>`).join("");

    const sub = r.subscription;
    main.innerHTML = `
      <div class="adm-page">
        <div class="adm-detail-head">
          <button class="adm-link" id="blBack">← billing</button>
          <h1>${esc(r.agency.name)}</h1>
          <div class="adm-detail-sub">
            status <b>${esc(r.agency.status)}</b> ·
            <span class="adm-badge adm-badge-${r.billable ? "ok" : "muted"}">${r.billable ? "billable" : "not billed"}</span> ·
            plan ${esc(r.agency.plan || "—")} ·
            <span class="adm-muted">id ${esc(r.agency.id)}</span>
          </div>
        </div>

        <div class="adm-kpi-row">
          <div class="adm-kpi adm-kpi-strong"><div class="adm-kpi-label">Agency monthly</div><div class="adm-kpi-val" id="blTotal">${money(r.monthlyCents)}</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">Models</div><div class="adm-kpi-val">${(r.models || []).length}</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">Period end</div><div class="adm-kpi-val" style="font-size:14px">${r.agency.currentPeriodEnd ? esc(String(r.agency.currentPeriodEnd).slice(0, 10)) : "—"}</div></div>
        </div>

        <div class="adm-bulk-bar">
          <span>Bulk set tier for all models:</span>
          <select id="blBulkTier">${Object.entries(r.tiers).map(([k, v]) => `<option value="${k}">${esc(v.label)} (${money(v.priceCents)})</option>`).join("")}</select>
          <button class="adm-btn adm-btn-sm" id="blBulkApply">apply to all</button>
        </div>

        <div class="adm-card">
          <div class="adm-card-title">Per-model billing — edit & save each line</div>
          <table class="adm-table adm-billing-table">
            <thead><tr><th>Model</th><th>Tier</th><th>Base $</th><th>AI chatter</th><th>Outreach</th><th>Excl</th><th>Line</th><th></th></tr></thead>
            <tbody>${rows || `<tr><td colspan="8" class="adm-muted">no models connected</td></tr>`}</tbody>
          </table>
        </div>
      </div>`;

    main.querySelector("#blBack").addEventListener("click", () => { local.view = "overview"; render(main); });

    // tier select auto-fills price from catalog (except CUSTOM)
    main.querySelectorAll("tr[data-creator]").forEach((tr) => {
      const tierSel = tr.querySelector(".bl-tier");
      const priceInp = tr.querySelector(".bl-price");
      tierSel.addEventListener("change", () => {
        const t = tierSel.value;
        if (t !== "CUSTOM" && r.tiers[t]) priceInp.value = (r.tiers[t].priceCents / 100).toFixed(0);
        recalcLine(tr); recalcTotal(main);
      });
      tr.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => { recalcLine(tr); recalcTotal(main); }));
      tr.querySelector(".bl-save").addEventListener("click", () => saveLine(main, tr));
    });

    main.querySelector("#blBulkApply").addEventListener("click", async () => {
      const tier = main.querySelector("#blBulkTier").value;
      if (!confirm(`Set tier "${tier}" for ALL non-excluded models of this agency?`)) return;
      const res = await A().billingApplyTier(agencyId, { tier });
      R().toast(res?.ok ? `applied to ${res.updated} models` : "failed", res?.ok ? "ok" : "error");
      if (res?.ok) renderAgency(main, agencyId);
    });
  }

  function lineFromRow(tr) {
    if (tr.querySelector(".bl-excl").checked) return 0;
    let c = Math.round(Number(tr.querySelector(".bl-price").value || 0) * 100);
    if (tr.querySelector(".bl-ai").checked) c += Math.round(Number(tr.querySelector(".bl-ai-price").value || 0) * 100);
    if (tr.querySelector(".bl-or").checked) c += Math.round(Number(tr.querySelector(".bl-or-price").value || 0) * 100);
    return c;
  }
  function recalcLine(tr) { tr.querySelector(".bl-line").textContent = money(lineFromRow(tr)); }
  function recalcTotal(main) {
    let t = 0;
    main.querySelectorAll("tr[data-creator]").forEach((tr) => { t += lineFromRow(tr); });
    const el = main.querySelector("#blTotal"); if (el) el.textContent = money(t);
  }

  async function saveLine(main, tr) {
    const btn = tr.querySelector(".bl-save");
    btn.disabled = true; btn.textContent = "…";
    const body = {
      tier: tr.querySelector(".bl-tier").value,
      corePriceCents: Math.round(Number(tr.querySelector(".bl-price").value || 0) * 100),
      aiChatterEnabled: tr.querySelector(".bl-ai").checked,
      aiChatterPriceCents: Math.round(Number(tr.querySelector(".bl-ai-price").value || 0) * 100),
      outreachEnabled: tr.querySelector(".bl-or").checked,
      outreachPriceCents: Math.round(Number(tr.querySelector(".bl-or-price").value || 0) * 100),
      billingExcluded: tr.querySelector(".bl-excl").checked,
      reason: "admin billing edit",
    };
    const res = await A().billingSetCreator(tr.dataset.creator, body);
    btn.disabled = false; btn.textContent = "save";
    if (res?.ok) {
      R().toast("saved " + money(res.lineCents), "ok");
      tr.querySelector(".bl-line").textContent = money(res.lineCents);
      tr.classList.toggle("adm-row-excluded", body.billingExcluded);
      recalcTotal(main);
    } else {
      R().toast("save failed", "error");
    }
  }

  window.OnlinodAdminBilling = { render };
})();
