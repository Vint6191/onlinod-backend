/* public/admin/modules/admin-data/admin-data.js
   ────────────────────────────────────────────────────────────
   "Data" section — deep explorer over every data entity.
     - Health: anomaly detector (clones, stuck bumps, orphans…)
     - Browser: pick an entity, filter by agency/creator, view rows
     - Inspect any row as raw JSON, delete single or bulk
     - One-click cleanup actions (dedupe clones / purge stuck)
   Depends on window.OnlinodAdminApi data* methods.
   ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;
  const esc = (v) => R().escapeHtml(v);

  // entity key → { label, api(query), columns:[{k,label,fmt?}], model (for delete) }
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
      label: "Bump Deliveries", model: "automationDelivery",
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
      label: "Hidden Online", model: "hiddenOnlineUser",
      api: (q) => A().dataHiddenOnline(q),
      cols: [
        { k: "fanId", label: "Fan" },
        { k: "username", label: "Username" },
        { k: "status", label: "Status" },
        { k: "totalSpentCents", label: "Spent", fmt: fmtMoney },
        { k: "lastSignalAt", label: "Last signal", fmt: fmtDate },
      ],
    },
    "follow-back": {
      label: "Follow Back", model: "followBackTask",
      api: (q) => A().dataFollowBack(q),
      cols: [
        { k: "fanId", label: "Fan" },
        { k: "username", label: "Username" },
        { k: "action", label: "Action" },
        { k: "status", label: "Status" },
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
  function fmtMoney(v) { const n = Number(v || 0); return "$" + (n / 100).toFixed(2); }

  // local view state (kept on the module, simple)
  const view = { tab: "health", entity: "deliveries", filters: { agencyId: "", creatorId: "" }, rows: [], total: 0, statusCounts: null, selected: new Set(), loading: false };

  async function render(main) {
    main.innerHTML = `
      <div class="adm-page">
        <div class="adm-page-head">
          <h1>Data Explorer</h1>
          <div class="adm-page-sub">inspect, search and clean every entity across all agencies</div>
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
        ${a.key === "delivery_clones" && a.count > 0 ? `<button class="adm-btn adm-btn-sm adm-btn-warn" data-fix="dedupe">dedupe clones</button>` : ""}
        ${a.key === "stuck_bumps" && a.count > 0 ? `<button class="adm-btn adm-btn-sm adm-btn-warn" data-fix="purge-stuck">purge stuck</button>` : ""}
      </div>`).join("");

    body.innerHTML = `
      <div class="adm-anomaly-grid">${cards}</div>
      <div class="adm-muted" style="margin-top:12px">checked ${esc(fmtDate(r.checkedAt))}</div>`;

    body.querySelector('[data-fix="dedupe"]')?.addEventListener("click", async (e) => {
      if (!confirm("Delete all duplicate delivery clones (keep newest per messageId)?")) return;
      e.target.disabled = true; e.target.textContent = "working…";
      const res = await A().dataPurgeDeliveries({ dedupeClones: true });
      R().toast(res?.ok ? `removed ${res.deletedClones} clones` : "failed", res?.ok ? "ok" : "error");
      renderHealth(body);
    });
    body.querySelector('[data-fix="purge-stuck"]')?.addEventListener("click", async (e) => {
      if (!confirm("Delete stuck bumps (pending/checking older than 3 days)?")) return;
      e.target.disabled = true; e.target.textContent = "working…";
      const res = await A().dataPurgeDeliveries({ statuses: ["pending_reply", "checking_reply"], olderThanDays: 3 });
      R().toast(res?.ok ? `purged ${res.deletedByFilter}` : "failed", res?.ok ? "ok" : "error");
      renderHealth(body);
    });
  }

  // ── BROWSE (entity tables) ──────────────────────────────────
  async function renderBrowse(body) {
    const opts = Object.entries(ENTITIES).map(([k, v]) => `<option value="${k}" ${k === view.entity ? "selected" : ""}>${esc(v.label)}</option>`).join("");
    body.innerHTML = `
      <div class="adm-data-controls">
        <select id="admEntity">${opts}</select>
        <input id="admFAgency" placeholder="agencyId (optional)" value="${esc(view.filters.agencyId)}" />
        <input id="admFCreator" placeholder="creatorId (optional)" value="${esc(view.filters.creatorId)}" />
        <button class="adm-btn adm-btn-sm" id="admLoad">load</button>
        <span class="adm-flex-spacer"></span>
        <button class="adm-btn adm-btn-sm adm-btn-danger" id="admBulkDel" disabled>delete selected</button>
      </div>
      <div id="admDataTable"><div class="adm-muted">pick an entity and press load</div></div>`;

    body.querySelector("#admEntity").addEventListener("change", (e) => { view.entity = e.target.value; view.selected.clear(); });
    body.querySelector("#admLoad").addEventListener("click", () => loadEntity(body));
    body.querySelector("#admBulkDel").addEventListener("click", () => bulkDelete(body));
  }

  async function loadEntity(body) {
    view.filters.agencyId = body.querySelector("#admFAgency").value.trim();
    view.filters.creatorId = body.querySelector("#admFCreator").value.trim();
    view.selected.clear();
    const table = body.querySelector("#admDataTable");
    table.innerHTML = `<div class="adm-loading">loading…</div>`;
    const ent = ENTITIES[view.entity];
    const r = await ent.api({ agencyId: view.filters.agencyId || undefined, creatorId: view.filters.creatorId || undefined, limit: 200 });
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

    const head = `<tr><th class="adm-col-check"><input type="checkbox" id="admChkAll"></th>${ent.cols.map((c) => `<th>${esc(c.label)}</th>`).join("")}<th></th></tr>`;
    const rows = view.rows.map((row) => {
      const cells = ent.cols.map((c) => {
        const raw = row[c.k];
        const val = c.fmt ? c.fmt(raw) : (raw == null ? "—" : String(raw));
        return `<td title="${esc(typeof raw === "object" ? JSON.stringify(raw) : raw)}">${esc(truncate(val, 40))}</td>`;
      }).join("");
      return `<tr data-id="${esc(row.id)}">
        <td class="adm-col-check"><input type="checkbox" class="admRowChk" data-id="${esc(row.id)}"></td>
        ${cells}
        <td class="adm-row-actions">
          <button class="adm-link" data-inspect="${esc(row.id)}">inspect</button>
          <button class="adm-link adm-link-danger" data-del="${esc(row.id)}">del</button>
        </td>
      </tr>`;
    }).join("");

    table.innerHTML = `
      ${statusBar}
      <div class="adm-muted" style="margin:6px 0">${view.rows.length} shown of ${view.total} total</div>
      <table class="adm-table"><thead>${head}</thead><tbody>${rows || `<tr><td colspan="99" class="adm-muted">no rows</td></tr>`}</tbody></table>`;

    // select-all
    table.querySelector("#admChkAll")?.addEventListener("change", (e) => {
      table.querySelectorAll(".admRowChk").forEach((c) => { c.checked = e.target.checked; toggleSel(c.dataset.id, e.target.checked); });
      updateBulkBtn(body);
    });
    table.querySelectorAll(".admRowChk").forEach((c) => c.addEventListener("change", () => { toggleSel(c.dataset.id, c.checked); updateBulkBtn(body); }));
    table.querySelectorAll("[data-inspect]").forEach((b) => b.addEventListener("click", () => inspect(ent.model, b.dataset.inspect)));
    table.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => delOne(body, ent.model, b.dataset.del)));
  }

  function toggleSel(id, on) { if (on) view.selected.add(id); else view.selected.delete(id); }
  function updateBulkBtn(body) { const b = body.querySelector("#admBulkDel"); if (b) { b.disabled = view.selected.size === 0; b.textContent = view.selected.size ? `delete selected (${view.selected.size})` : "delete selected"; } }

  async function inspect(model, id) {
    const r = await A().dataInspect(model, id);
    if (!r || !r.ok) { R().toast("inspect failed", "error"); return; }
    showModal(`${model} · ${id}`, `<pre class="adm-json">${esc(JSON.stringify(r.record, null, 2))}</pre>`);
  }

  async function delOne(body, model, id) {
    if (!confirm(`Delete this ${model}? (soft if supported)`)) return;
    const r = await A().dataDeleteRecord(model, id);
    R().toast(r?.ok ? "deleted" : "delete failed", r?.ok ? "ok" : "error");
    if (r?.ok) loadEntity(body);
  }

  async function bulkDelete(body) {
    const ent = ENTITIES[view.entity];
    const ids = Array.from(view.selected);
    if (!ids.length) return;
    if (!confirm(`Delete ${ids.length} ${ent.label} records?`)) return;
    const r = await A().dataBulkDelete({ model: ent.model, ids });
    R().toast(r?.ok ? `deleted ${r.deleted}` : "bulk delete failed", r?.ok ? "ok" : "error");
    if (r?.ok) loadEntity(body);
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
