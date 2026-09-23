/* public/admin/modules/admin-data/admin-data.js
   ────────────────────────────────────────────────────────────
   "Data" section — deep explorer over every data entity.
     - Health: anomaly detector (clones, stuck bumps, orphans…)
     - Browser: pick an entity, filter by agency/creator, view rows
     - Inspect rows as raw JSON; archive explicit terminal deliveries
     - Mutations use typed commands with durable receipts
   Depends on window.OnlinodAdminApi data* methods.
   ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;
  const esc = (v) => R().escapeHtml(v);

  // entity key → { label, api(query), columns:[{k,label,fmt?}], model (for inspection) }
  const ENTITIES = {
    "crm-profiles": {
      label: "CRM Profiles", model: "crmProfile",
      api: (q) => A().crmProfiles(q),
      cols: [
        { k: "fanId", label: "Fan" },
        { k: "username", label: "Username" },
        { k: "name", label: "Name" },
        { k: "spenderTier", label: "Tier" },
        { k: "_count", label: "Tags", fmt: (v) => (v ? v.tags : 0) },
        { k: "updatedAt", label: "Updated", fmt: fmtDate },
      ],
    },
    "crm-tags": {
      label: "CRM Tags", model: "crmProfileTag",
      api: (q) => A().crmTags(q),
      cols: [
        { k: "label", label: "Label" },
        { k: "kind", label: "Kind" },
        { k: "category", label: "Category" },
        { k: "nicheLevel", label: "Niche" },
        { k: "negative", label: "Neg", fmt: (v) => (v ? "yes" : "") },
      ],
    },
    "deliveries": {
      label: "Automation Deliveries", model: "automationDelivery",
      api: (q) => A().dataDeliveries(q),
      cols: [
        { k: "fanId", label: "Fan" },
        { k: "status", label: "Status" },
        { k: "messageId", label: "MsgId" },
        { k: "sentAt", label: "Sent", fmt: fmtDate },
        { k: "createdAt", label: "Created", fmt: fmtDate },
      ],
    },
    "hidden-online": {
      label: "Hidden Online — Current", model: null,
      api: (q) => A().dataHiddenOnline(q),
      cols: [
        { k: "fanId", label: "Fan" },
        { k: "username", label: "Username" },
        { k: "status", label: "Status" },
        { k: "totalSpentCents", label: "Spent", fmt: fmtMoney },
        { k: "observedAt", label: "Observed", fmt: fmtDate },
        { k: "statusUpdatedAt", label: "Status updated", fmt: fmtDate },
      ],
    },
    "follow-back": {
      label: "Follow Back — Current", model: null,
      api: (q) => A().dataFollowBack(q),
      cols: [
        { k: "fanId", label: "Fan" },
        { k: "username", label: "Username" },
        { k: "latestActionType", label: "Action" },
        { k: "latestStatus", label: "Delivery status" },
        { k: "state", label: "Candidate state" },
        { k: "currentEligibility", label: "Eligibility" },
        { k: "updatedAt", label: "Updated", fmt: fmtDate },
      ],
    },
    "vault-sales": {
      label: "Vault Sales", model: "vaultMediaSale",
      api: (q) => A().dataVaultSales(q),
      cols: [
        { k: "messageId", label: "MsgId" },
        { k: "mediaId", label: "Media" },
        { k: "status", label: "Status" },
        { k: "allocatedAmountCents", label: "Amount", fmt: fmtMoney },
        { k: "purchasedAt", label: "Purchased", fmt: fmtDate },
      ],
    },
    "money": {
      label: "Money Attribution", model: "moneyAttribution",
      api: (q) => A().dataMoney(q),
      cols: [
        { k: "eventType", label: "Type" },
        { k: "amountCents", label: "Amount", fmt: fmtMoney },
        { k: "fanId", label: "Fan" },
        { k: "state", label: "State" },
        { k: "occurredAt", label: "When", fmt: fmtDate },
      ],
    },
  };

  function fmtDate(v) { if (!v) return "—"; const d = new Date(v); return isNaN(d) ? "—" : d.toISOString().slice(0, 16).replace("T", " "); }
  function fmtMoney(v, row = null) {
    if (v == null || (row?.valueAvailability && row.valueAvailability !== "AVAILABLE")) return "—";
    const n = Number(v);
    return Number.isFinite(n) ? "$" + (n / 100).toFixed(2) : "—";
  }

  // local view state (kept on the module, simple)
  const view = { tab: "health", entity: "deliveries", filters: { agencyId: "", creatorId: "" }, rows: [], total: 0, statusCounts: null, selected: new Set(), loading: false, requestId: 0 };

  async function render(main) {
    main.innerHTML = `
      <div class="adm-page">
        <div class="adm-page-head">
          <h1>Data Explorer</h1>
          <div class="adm-page-sub">inspect data; archive selected terminal deliveries with a reason</div>
        </div>
        <div class="adm-tabs">
          <button class="adm-tab ${view.tab === "health" ? "active" : ""}" data-tab="health">Health</button>
          <button class="adm-tab ${view.tab === "browse" ? "active" : ""}" data-tab="browse">Browse</button>
        </div>
        <div id="admDataBody"></div>
      </div>`;
    main.querySelectorAll(".adm-tab").forEach((b) => b.addEventListener("click", () => { view.tab = b.dataset.tab; render(main); }));
    if (view.tab === "health") renderHealth(main.querySelector("#admDataBody"));
    else renderBrowse(main.querySelector("#admDataBody"));
  }

  // ── HEALTH (anomalies) ──────────────────────────────────────
  async function renderHealth(body) {
    body.innerHTML = `<div class="adm-loading">scanning…</div>`;
    const r = await A().dataAnomalies();
    if (!r || !r.ok) { body.innerHTML = `<div class="adm-error">failed to load anomalies</div>`; return; }

    const cards = (r.anomalies || []).map((a) => `
      <div class="adm-anomaly adm-anomaly-${esc(a.level)}">
        <div class="adm-anomaly-top">
          <span class="adm-anomaly-dot"></span>
          <b>${esc(a.title)}</b>
          <span class="adm-anomaly-count">${esc(a.count != null ? a.count : "")}</span>
        </div>
        <div class="adm-anomaly-detail">${esc(a.detail)}</div>
      </div>`).join("");

    body.innerHTML = `
      <div class="adm-anomaly-grid">${cards}</div>
      <div class="adm-muted" style="margin-top:12px">checked ${esc(fmtDate(r.checkedAt))}</div>`;

    body.insertAdjacentHTML("beforeend", '<p class="adm-muted">Inspect anomalies before acting. Stuck work uses its recovery flow. Terminal archival is available in Browse for one agency and creator.</p>');
  }

  // ── BROWSE (entity tables) ──────────────────────────────────
  async function renderBrowse(body) {
    const opts = Object.entries(ENTITIES).map(([k, v]) => `<option value="${k}" ${k === view.entity ? "selected" : ""}>${esc(v.label)}</option>`).join("");
    const readOnlyCurrent = view.entity !== "deliveries";
    body.innerHTML = `
      <div class="adm-data-controls">
        <select id="admEntity">${opts}</select>
        <input id="admFAgency" placeholder="agencyId (optional)" value="${esc(view.filters.agencyId)}" />
        <input id="admFCreator" placeholder="creatorId (optional)" value="${esc(view.filters.creatorId)}" />
        <button class="adm-btn adm-btn-sm" id="admLoad">load</button>
        <span class="adm-flex-spacer"></span>
        <button class="adm-btn adm-btn-sm adm-btn-danger" id="admBulkDel" ${readOnlyCurrent ? "hidden" : ""} disabled>archive selected</button>
        <input id="admArchiveCutoff" type="datetime-local" aria-label="Archive records finished before (UTC)" />
        <input id="admArchiveReason" placeholder="Archive reason" maxlength="500" />
        <span class="adm-muted">Archive cutoff is UTC. Maximum 100 selected terminal records; monthly counters are preserved.</span>
      </div>
      <div id="admDataTable"><div class="adm-muted">pick an entity and press load</div></div>`;

    body.querySelector("#admEntity").addEventListener("change", (e) => {
      view.entity = e.target.value;
      view.selected.clear(); view.rows = []; view.requestId++;
      const bulk = body.querySelector("#admBulkDel");
      if (bulk) { bulk.hidden = view.entity !== "deliveries"; bulk.disabled = true; bulk.textContent = "archive selected"; }
      const table = body.querySelector("#admDataTable");
      if (table) table.innerHTML = `<div class="adm-muted">press load to view ${esc(ENTITIES[view.entity]?.label || "entity")}</div>`;
    });
    body.querySelector("#admLoad").addEventListener("click", () => loadEntity(body));
    body.querySelector("#admBulkDel").addEventListener("click", () => archiveSelected(body));
  }

  async function loadEntity(body) {
    view.filters.agencyId = body.querySelector("#admFAgency").value.trim();
    view.filters.creatorId = body.querySelector("#admFCreator").value.trim();
    view.selected.clear(); view.rows = []; updateBulkBtn(body);
    const requestId = ++view.requestId;
    const table = body.querySelector("#admDataTable");
    table.innerHTML = `<div class="adm-loading">loading…</div>`;
    const ent = ENTITIES[view.entity];
    const r = await ent.api({ agencyId: view.filters.agencyId || undefined, creatorId: view.filters.creatorId || undefined, limit: 200 });
    if (requestId !== view.requestId) return;
    if (!r || !r.ok) { table.innerHTML = `<div class="adm-error">load failed</div>`; return; }
    view.rows = r.items || [];
    view.total = r.total != null ? r.total : view.rows.length;
    view.statusCounts = r.statusCounts || null;
    renderTable(body);
  }

  function renderTable(body) {
    const ent = ENTITIES[view.entity];
    const table = body.querySelector("#admDataTable");
    const statusBar = view.statusCounts
      ? `<div class="adm-status-bar">${Object.entries(view.statusCounts).map(([s, n]) => `<span>${esc(s)}: <b>${esc(n)}</b></span>`).join("")}</div>` : "";

    const readOnly = view.entity !== "deliveries";
    const head = `<tr>${readOnly ? "" : '<th class="adm-col-check"><input type="checkbox" id="admChkAll"></th>'}${ent.cols.map((c) => `<th>${esc(c.label)}</th>`).join("")}${ent.model ? "<th></th>" : ""}</tr>`;
    const rows = view.rows.map((row) => {
      const cells = ent.cols.map((c) => {
        const raw = row[c.k];
        const val = c.fmt ? c.fmt(raw, row) : (raw == null ? "—" : String(raw));
        return `<td title="${esc(typeof raw === "object" ? JSON.stringify(raw) : raw)}">${esc(truncate(val, 40))}</td>`;
      }).join("");
      if (!ent.model) return `<tr>${cells}</tr>`;
      return `<tr data-id="${esc(row.id)}">
        ${readOnly ? "" : `<td class="adm-col-check"><input type="checkbox" class="admRowChk" data-id="${esc(row.id)}" ${canSelect(row) ? "" : "disabled"}></td>`}
        ${cells}
        <td class="adm-row-actions">
          <button class="adm-link" data-inspect="${esc(row.id)}">inspect</button>
        </td>
      </tr>`;
    }).join("");

    table.innerHTML = `
      ${statusBar}
      <div class="adm-muted" style="margin:6px 0">${view.rows.length} shown of ${view.total} total${readOnly ? " · read-only" : ""}</div>
      <table class="adm-table"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="99" class="adm-muted">no rows</td></tr>`}</tbody></table>`;

    table.querySelectorAll("[data-inspect]").forEach((b) => b.addEventListener("click", () => inspect(ent.model, b.dataset.inspect)));
    updateBulkBtn(body);
    if (readOnly) return;

    // select-all
    table.querySelector("#admChkAll")?.addEventListener("change", (e) => {
      view.selected.clear();
      table.querySelectorAll(".admRowChk").forEach((c) => { if (!c.disabled) { c.checked = e.target.checked && view.selected.size < 100; toggleSel(c.dataset.id, c.checked); } });
      updateBulkBtn(body);
    });
    table.querySelectorAll(".admRowChk").forEach((c) => c.addEventListener("change", () => { toggleSel(c.dataset.id, c.checked); c.checked = view.selected.has(c.dataset.id); updateBulkBtn(body); }));


  }

  function toggleSel(id, on) { if (!on) view.selected.delete(id); else if (view.selected.size < 100) view.selected.add(id); }
  function updateBulkBtn(body) {
    const b = body.querySelector("#admBulkDel");
    if (!b) return;
    const mutable = view.entity === "deliveries";
    b.hidden = !mutable;
    b.disabled = view.loading || !mutable || view.selected.size === 0;
    b.textContent = mutable && view.selected.size ? `archive selected (${view.selected.size})` : "archive selected";
  }

  async function inspect(model, id) {
    if (!model) return;
    const r = await A().dataInspect(model, id);
    if (!r || !r.ok) { R().toast("inspect failed", "error"); return; }
    showModal(`${model} · ${id}`, `<pre class="adm-json">${esc(JSON.stringify(r.record, null, 2))}</pre>`);
  }

  function canSelect(row) {
    return row.originKind === "AUTOMATION" && ["COMPLETED","FAILED","SKIPPED","CANCELED"].includes(row.status) && row.finishedAt && row.updatedAt && row.agencyId === view.filters.agencyId && row.creatorId === view.filters.creatorId;
  }
  async function archiveSelected(body) {
    if (view.loading || view.entity !== "deliveries" || !view.selected.size) return;
    const reason = body.querySelector("#admArchiveReason").value.trim();
    const cutoff = body.querySelector("#admArchiveCutoff").value;
    const olderThan = cutoff ? new Date(cutoff + "Z") : null;
    if (!view.filters.agencyId || !view.filters.creatorId || !reason || !olderThan || !Number.isFinite(olderThan.getTime())) { R().toast("Load one agency and creator; supply cutoff (UTC) and reason", "error"); return; }
    const items = view.rows.filter(row => view.selected.has(row.id) && canSelect(row)).map(row => ({ id: row.id, expectedUpdatedAt: row.updatedAt })).sort((a,b) => a.id.localeCompare(b.id));
    if (!items.length || items.length !== view.selected.size) { R().toast("Reload selection", "error"); return; }
    if (!confirm(`Archive ${items.length} terminal records before ${olderThan.toISOString()}? Monthly counters are preserved.`)) return;
    view.loading = true; updateBulkBtn(body);
    try {
      const r = await A().dataArchiveDeliveries(view.filters.creatorId, { agencyId: view.filters.agencyId, reason, olderThan: olderThan.toISOString(), items });
      R().toast(r?.ok ? `archived ${r.archived}` : (r?.error || "Archive result unknown; retry the same selection"), r?.ok ? "ok" : "error");
      if (r?.ok) await loadEntity(body);
    } catch (_) { R().toast("Archive result unknown; retry the same selection", "error"); }
    finally { view.loading = false; updateBulkBtn(body); }
  }

  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; }

  function showModal(title, html) {
    let m = document.querySelector(".adm-modal-overlay");
    if (m) m.remove();
    m = document.createElement("div");
    m.className = "adm-modal-overlay";
    m.innerHTML = `<div class="adm-modal"><div class="adm-modal-head"><b>${esc(title)}</b><button class="adm-modal-close">✕</button></div><div class="adm-modal-body">${html}</div></div>`;
    document.body.appendChild(m);
    m.querySelector(".adm-modal-close").addEventListener("click", () => m.remove());
    m.addEventListener("click", (e) => { if (e.target === m) m.remove(); });
  }

  window.OnlinodAdminData = { render };
})();
