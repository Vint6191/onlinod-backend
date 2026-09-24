/* public/admin/modules/admin-billing/admin-billing.js
   ────────────────────────────────────────────────────────────
   Billing management. Subscription lives on the agency, priced
   per connected model. Two views:
     overview        — real MRR (status-filtered) + agency rollup
     agency detail   — every model with editable tier/price/addons,
                       live line totals, bounded selected-model bulk commands
   Routed via section "billing" (overview) and a local detail state.
   ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;
  const esc = (v) => R().escapeHtml(v);
  const money = (c) => "$" + (Number(c || 0) / 100).toFixed(2);

  const local = { view: "overview", agencyId: null, tiers: null, overviewAfter: null, modelsAfter: null };

  function pageControls(page, after) {
    return `<div class="adm-bulk-bar"><button class="adm-btn bl-page-first" ${after ? "" : "disabled"}>First page</button><button class="adm-btn bl-page-next" ${page?.nextCursor ? "" : "disabled"}>Next page</button><span>Up to 100 rows per page</span></div>`;
  }
  function bindPage(root, page, go) {
    root.querySelector(".bl-page-first")?.addEventListener("click", () => go(null));
    root.querySelector(".bl-page-next")?.addEventListener("click", () => go(page.nextCursor));
  }

  async function render(main) {
    if (local.view === "agency" && local.agencyId) return renderAgency(main, local.agencyId);
    return renderOverview(main);
  }

  // ── OVERVIEW ────────────────────────────────────────────────
  async function renderOverview(main) {
    main.innerHTML = '<div id="blCommercialPolicy"></div><div id="blOverview"></div>';
    window.OnlinodAdminCommercialPolicy?.render(main.querySelector("#blCommercialPolicy"));
    const overview = main.querySelector("#blOverview");
    overview.innerHTML = `<div class="adm-page"><div class="adm-loading">loading billing…</div></div>`;
    const r = await A().billingOverview(local.overviewAfter);
    if (!r || !r.ok) { overview.innerHTML = `<div class="adm-page"><div class="adm-error">failed to load billing</div></div>`; return; }

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

    overview.innerHTML = `
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
        ${pageControls(r.page, local.overviewAfter)}
        <div class="adm-muted">MRR counts active paid entitlements. Trial potential uses current configured prices.</div>
      </div>`;

    bindPage(overview, r.page, after => { local.overviewAfter = after; return renderOverview(main); });
    overview.querySelectorAll("tr[data-agency]").forEach((tr) => tr.addEventListener("click", () => {
      local.view = "agency"; local.agencyId = tr.dataset.agency; local.modelsAfter = null; render(main);
    }));
  }

  // ── AGENCY DETAIL (per-model editor) ────────────────────────
  async function renderAgency(main, agencyId) {
    main.innerHTML = `<div class="adm-page"><div class="adm-loading">loading agency billing…</div></div>`;
    const r = await A().billingAgency(agencyId, local.modelsAfter);
    if (!r || !r.ok) { main.innerHTML = `<div class="adm-page"><div class="adm-error">failed</div></div>`; return; }
    local.tiers = r.tiers || {};

    const tierOpts = (sel) => Object.entries(r.tiers).map(([k, v]) =>
      `<option value="${k}" ${k === sel ? "selected" : ""}>${esc(v.label)} (${k === "CUSTOM" ? "explicit price" : money(v.priceCents)})</option>`).join("");

    const priceSource = (component, value) => `<select class="bl-${component}-source"><option value="CATALOG" ${value !== "OVERRIDE" ? "selected" : ""}>Global price</option><option value="OVERRIDE" ${value === "OVERRIDE" ? "selected" : ""}>Individual price</option></select>`;
    const rows = (r.models || []).map((m) => `
      <tr data-creator="${esc(m.creatorId)}" data-pricing-revision="${Number(m.pricingRevision || 0)}" data-configured-line="${Number(m.configuredLineCents || 0)}" class="${m.billingExcluded ? "adm-row-excluded" : ""}">
        <td>
          <label><input class="bl-select" type="checkbox" ${m.billingExcluded ? "disabled" : ""}> <b>${esc(m.displayName || m.username || m.creatorId.slice(-8))}</b></label>
          <div class="adm-muted">@${esc(m.username || "—")} · ${esc(m.creatorStatus || "")}</div>
        </td>
        <td><select class="bl-mode"><option value="AUTO" ${m.tierMode !== "MANUAL" ? "selected" : ""}>Automatic tier</option><option value="MANUAL" ${m.tierMode === "MANUAL" ? "selected" : ""}>Fixed tier</option></select><select class="bl-tier">${tierOpts(m.tier || "STARTER")}</select></td>
        <td>${priceSource("core", m.corePriceSource)}<input class="bl-price" type="number" min="0" step="0.01" value="${(Number(m.corePriceCents || 0) / 100).toFixed(2)}" style="width:80px"> </td>
        <td class="adm-addon-cell">
          <label><input type="checkbox" class="bl-ai" ${m.aiChatterEnabled ? "checked" : ""}> AI</label>
          ${priceSource("ai", m.aiChatterPriceSource)}<input class="bl-ai-price" type="number" min="0" step="0.01" value="${(Number(m.aiChatterPriceCents || 0) / 100).toFixed(2)}" style="width:64px">
        </td>
        <td class="adm-addon-cell">
          <label><input type="checkbox" class="bl-or" ${m.outreachEnabled ? "checked" : ""}> OR</label>
          ${priceSource("or", m.outreachPriceSource)}<input class="bl-or-price" type="number" min="0" step="0.01" value="${(Number(m.outreachPriceCents || 0) / 100).toFixed(2)}" style="width:64px">
        </td>
        <td><label><input type="checkbox" class="bl-excl" ${m.billingExcluded ? "checked" : ""}> excl</label></td>
        <td class="adm-money bl-line">${money(m.configuredLineCents)}</td>
        <td><button class="adm-btn adm-btn-sm bl-save">save</button><button class="adm-btn adm-btn-sm bl-check" hidden>check result</button></td>
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
          <div class="adm-kpi adm-kpi-strong"><div class="adm-kpi-label">Configured monthly · all models</div><div class="adm-kpi-val" id="blTotal" data-configured-total="${Number(r.configuredMonthlyCents || 0)}">${money(r.configuredMonthlyCents)}</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">Models</div><div class="adm-kpi-val">${r.modelsTotal}</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">Period end</div><div class="adm-kpi-val" style="font-size:14px">${r.agency.currentPeriodEnd ? esc(String(r.agency.currentPeriodEnd).slice(0, 10)) : "—"}</div></div>
        </div>

        <div class="adm-bulk-bar">
          <span>Set tier for selected models (maximum 100):</span>
          <select id="blBulkTier">${Object.entries(r.tiers).map(([k, v]) => `<option value="${k}">${esc(v.label)} (${k === "CUSTOM" ? "explicit price" : money(v.priceCents)})</option>`).join("")}</select>
          <input id="blBulkCustomPrice" type="number" min="0" max="10000" step="0.01" placeholder="CUSTOM price $">
          <input id="blBulkReason" maxlength="500" placeholder="Reason for change">
          <button class="adm-btn adm-btn-sm" id="blBulkApply">queue selected</button>
          <button class="adm-btn adm-btn-sm" id="blBulkCheck">check progress</button>
          <button class="adm-btn adm-btn-sm" id="blBulkCancel">cancel remaining</button>
          <button class="adm-btn adm-btn-sm" id="blBulkResume" disabled>resume remaining</button>
          <span id="blBulkProgress" role="status"></span>
          <details><summary>Results by model</summary><pre id="blBulkOutcomes"></pre></details>
        </div>

        <div class="adm-card">
          <div class="adm-card-title">Per-model billing — edit & save each line</div>
          <table class="adm-table adm-billing-table">
            <thead><tr><th>Model</th><th>Tier</th><th>Base $</th><th>AI chatter</th><th>Outreach</th><th>Excl</th><th>Line</th><th></th></tr></thead>
            <tbody>${rows || `<tr><td colspan="8" class="adm-muted">no models connected</td></tr>`}</tbody>
          </table>
          ${pageControls(r.page, local.modelsAfter)}
        </div>
      </div>`;

    bindPage(main, r.page, after => { local.modelsAfter = after; return renderAgency(main, agencyId); });
    main.querySelector("#blBack").addEventListener("click", () => { local.view = "overview"; render(main); });

    // tier select auto-fills price from catalog (except CUSTOM)
    main.querySelectorAll("tr[data-creator]").forEach((tr) => {
      const tierSel = tr.querySelector(".bl-tier");
      const priceInp = tr.querySelector(".bl-price");
      const mode = tr.querySelector(".bl-mode");
      const coreSource = tr.querySelector(".bl-core-source");
      function applySources() {
        const automatic = mode.value === "AUTO";
        tierSel.disabled = automatic;
        if (automatic) coreSource.value = "CATALOG";
        coreSource.disabled = automatic;
        for (const [component, selector] of [["core", ".bl-price"], ["ai", ".bl-ai-price"], ["or", ".bl-or-price"]]) tr.querySelector(selector).disabled = tr.querySelector(`.bl-${component}-source`).value === "CATALOG";
      }
      mode.addEventListener("change", applySources);
      for (const component of ["core", "ai", "or"]) tr.querySelector(`.bl-${component}-source`).addEventListener("change", applySources);
      applySources();
      tierSel.addEventListener("change", () => {
        const t = tierSel.value;
        if (t !== "CUSTOM" && r.tiers[t]) priceInp.value = (r.tiers[t].priceCents / 100).toFixed(2);
        recalcLine(tr); recalcTotal(main);
      });
      tr.querySelectorAll("input").forEach((inp) => inp.addEventListener("input", () => { recalcLine(tr); recalcTotal(main); }));
      tr.querySelector(".bl-save").addEventListener("click", () => saveLine(main, tr));
      tr.querySelector(".bl-check").addEventListener("click", async () => {
        try {
          const result = await A().resolveCommand(`/api/admin/billing/creator/${encodeURIComponent(tr.dataset.creator)}`, "PATCH");
          if (!result.pending) { R().toast("Result confirmed; current prices reloaded", "ok"); await renderAgency(main, agencyId); }
          else R().toast("Result is still unknown. Retry the same change.", "error");
        } catch (_) { R().toast("Status could not be retrieved. Retry later.", "error"); }
      });
    });

    const bulkStorageKey = `onlinod_admin_bulk:${agencyId}`;
    let bulkCommandId = null;
    try { bulkCommandId = sessionStorage.getItem(bulkStorageKey); } catch (_) {}
    let submitting = false;
    let resumePayload = null;
    const progressEl = main.querySelector("#blBulkProgress");
    async function checkBulk() {
      if (!bulkCommandId) { progressEl.textContent = "No submitted command in this tab."; return; }
      const status = await A().commandStatus(bulkCommandId);
      if (!status?.ok) { progressEl.textContent = status?.error || "Result unknown; retry the same selection."; return; }
      const p = status.execution?.progress;
      resumePayload = status.execution?.resume || null;
      main.querySelector("#blBulkResume").disabled = !resumePayload;
      main.querySelector("#blBulkOutcomes").textContent = (p?.outcomes || []).map(item => `${item.creatorId}: ${item.status}${item.code ? " / " + item.code : ""}`).join("\n");
      progressEl.textContent = `${status.status}${status.execution?.workState === "RECONCILE_REQUIRED" ? " / RECONCILE_REQUIRED" : ""}: ${p?.nextIndex || 0}/${p?.total || 0}, changed ${p?.succeeded || 0}, rejected ${p?.rejected || 0}, skipped ${p?.skipped || 0}. ${p?.stoppedCode || ""}`;
    }
    main.querySelector("#blBulkCheck").addEventListener("click", () => checkBulk().catch(() => { progressEl.textContent = "Status unavailable; check again."; }));
    main.querySelector("#blBulkApply").addEventListener("click", async () => {
      if (submitting) return;
      const items = Array.from(main.querySelectorAll("tr[data-creator]")).filter(tr => tr.querySelector(".bl-select").checked).map(tr => ({ creatorId: tr.dataset.creator, expectedRevision: Number(tr.dataset.pricingRevision) }));
      const tier = main.querySelector("#blBulkTier").value;
      const reason = main.querySelector("#blBulkReason").value.trim();
      if (!items.length || items.length > 100 || !reason) { R().toast("Select 1–100 models and enter a reason.", "error"); return; }
      const body = { items, tier, reason };
      if (tier === "CUSTOM") {
        const raw = main.querySelector("#blBulkCustomPrice").value;
        if (!raw.trim() || !Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 10000) { R().toast("Enter a valid CUSTOM price.", "error"); return; }
        body.corePriceCents = Math.round(Number(raw) * 100);
      }
      if (!confirm(`Queue tier "${tier}" for these ${items.length} selected models? Changed prices will be rejected individually.`)) return;
      submitting = true;
      const button = main.querySelector("#blBulkApply"); button.disabled = true;
      try {
        const res = await A().billingApplyTier(agencyId, body);
        if (res?.commandId) { bulkCommandId = res.commandId; try { sessionStorage.setItem(bulkStorageKey, bulkCommandId); } catch (_) {} }
        R().toast(res?.accepted ? "Selection accepted; check progress for completion." : res?.error || "Submission failed", res?.accepted ? "ok" : "error");
        if (res?.accepted) await checkBulk();
      } catch (_) { progressEl.textContent = "Result unknown; retry the same selection."; }
      finally { submitting = false; button.disabled = false; }
    });
    main.querySelector("#blBulkResume").addEventListener("click", async () => {
      if (!resumePayload || submitting) return;
      const reason = main.querySelector("#blBulkReason").value.trim();
      if (!reason) { R().toast("Enter a reason for resuming.", "error"); return; }
      if (!confirm(`Resume ${resumePayload.items.length} remaining models with the original prices and versions?`)) return;
      submitting = true;
      try {
        const res = await A().billingApplyTier(agencyId, { ...resumePayload, reason });
        if (res?.commandId) { bulkCommandId = res.commandId; try { sessionStorage.setItem(bulkStorageKey, bulkCommandId); } catch (_) {} }
        R().toast(res?.accepted ? "Remaining selection accepted." : res?.error || "Resume failed", res?.accepted ? "ok" : "error");
        if (res?.accepted) await checkBulk();
      } catch (_) { progressEl.textContent = "Result unknown; check progress or retry the same resume."; }
      finally { submitting = false; }
    });
    main.querySelector("#blBulkCancel").addEventListener("click", async () => {
      if (!bulkCommandId || submitting) return;
      const reason = main.querySelector("#blBulkReason").value.trim();
      if (!reason) { R().toast("Enter a cancellation reason.", "error"); return; }
      if (!confirm("Cancel remaining changes? Completed changes stay in place.")) return;
      submitting = true;
      try {
        const res = await A().billingCancelTier(agencyId, { targetCommandId: bulkCommandId, reason });
        R().toast(res?.ok ? "Cancellation confirmed." : res?.error || "Cancellation result unknown; retry.", res?.ok ? "ok" : "error");
        await checkBulk();
      } catch (_) { progressEl.textContent = "Cancellation result unknown; check or retry."; }
      finally { submitting = false; }
    });
    if (bulkCommandId) checkBulk().catch(() => { progressEl.textContent = "Status unavailable; check again."; });
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
    main.querySelectorAll("tr[data-creator]").forEach((tr) => { t += lineFromRow(tr) - Number(tr.dataset.configuredLine || 0); });
    const el = main.querySelector("#blTotal"); if (el) el.textContent = money(Number(el.dataset.configuredTotal || 0) + t);
  }

  async function saveLine(main, tr) {
    const btn = tr.querySelector(".bl-save");
    btn.disabled = true; btn.textContent = "…";
    const body = {
      expectedRevision: Number(tr.dataset.pricingRevision),
      tierMode: tr.querySelector(".bl-mode").value,
      aiChatterEnabled: tr.querySelector(".bl-ai").checked,
      outreachEnabled: tr.querySelector(".bl-or").checked,
      billingExcluded: tr.querySelector(".bl-excl").checked,
      reason: "admin billing edit",
    };
    if (body.tierMode === "MANUAL") body.tier = tr.querySelector(".bl-tier").value;
    for (const [component, ui, selector] of [["core", "core", ".bl-price"], ["aiChatter", "ai", ".bl-ai-price"], ["outreach", "or", ".bl-or-price"]]) {
      body[component + "PriceSource"] = tr.querySelector(`.bl-${ui}-source`).value;
      if (body[component + "PriceSource"] === "OVERRIDE") body[component + "PriceCents"] = Math.round(Number(tr.querySelector(selector).value) * 100);
    }
    const res = await A().billingSetCreator(tr.dataset.creator, body);
    btn.disabled = false; btn.textContent = "save";
    tr.querySelector(".bl-check").hidden = !["NETWORK", "INVALID_JSON", "ADMIN_COMMAND_RESPONSE_UNKNOWN", "ADMIN_COMMAND_UNRESOLVED"].includes(res?.code);
    if (res?.ok) {
      tr.dataset.pricingRevision = String(res.billing.pricingRevision);
      for (const [key, selector] of [["corePriceCents", ".bl-price"], ["aiChatterPriceCents", ".bl-ai-price"], ["outreachPriceCents", ".bl-or-price"]]) tr.querySelector(selector).value = (res.billing[key] / 100).toFixed(2);
      R().toast("saved " + money(res.lineCents), "ok");
      tr.querySelector(".bl-line").textContent = money(res.lineCents);
      tr.classList.toggle("adm-row-excluded", body.billingExcluded);
      tr.querySelector(".bl-select").disabled = body.billingExcluded;
      if (body.billingExcluded) tr.querySelector(".bl-select").checked = false;
      recalcTotal(main);
    } else {
      R().toast(res?.error || "save failed", "error");
    }
  }

  window.OnlinodAdminBilling = { render };
})();
