/* public/admin/modules/admin-creator-detail/admin-creator-detail.js
   ────────────────────────────────────────────────────────────
   Full per-creator (model) view. Opened via R().pushDetail("creators", id).
     - header: model name, agency, status, billing tier
     - KPI row: profiles / tags / deliveries / replyRate / money …
     - tabs: CRM Profiles · Tags · Deliveries · Reply Rate · Hidden · FollowBack · Vault
   All data scoped to this creatorId. Uses admin data* api.
   ──────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;
  const S = () => window.OnlinodAdminState;
  const esc = (v) => R().escapeHtml(v);

  function fmtDate(v) { if (!v) return "—"; const d = new Date(v); return isNaN(d) ? "—" : d.toISOString().slice(0, 16).replace("T", " "); }
  function fmtMoney(v) { return "$" + (Number(v || 0) / 100).toFixed(2); }
  function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }

  const local = { tab: "overview", creatorId: null, overview: null, tabData: {}, loading: false };

  async function render(main) {
    const creatorId = S().sectionParam;
    if (!creatorId) { main.innerHTML = `<div class="adm-error">no creator id</div>`; return; }
    if (local.creatorId !== creatorId) { local.creatorId = creatorId; local.overview = null; local.tabData = {}; local.tab = "overview"; }

    main.innerHTML = `<div class="adm-page"><div class="adm-loading">loading model…</div></div>`;

    if (!local.overview) {
      const r = await A().creatorOverview(creatorId);
      if (!r || !r.ok) { main.innerHTML = `<div class="adm-page"><div class="adm-error">failed to load creator</div></div>`; return; }
      local.overview = r;
    }
    paint(main);
  }

  function paint(main) {
    const o = local.overview;
    const c = o.creator || {};
    const counts = o.counts || {};
    const bs = o.bumpStats || {};

    const kpis = [
      { label: "CRM profiles", val: counts.crmProfiles },
      { label: "CRM tags", val: counts.crmTags },
      { label: "Deliveries", val: counts.deliveries },
      { label: "Reply rate", val: (bs.replyRate || 0) + "%" },
      { label: "Hidden online", val: counts.hiddenOnline },
      { label: "Follow back", val: counts.followBack },
      { label: "Vault sales", val: counts.vaultSales },
      { label: "Money", val: fmtMoney(counts.moneyCents) },
    ].map((k) => `<div class="adm-kpi"><div class="adm-kpi-label">${esc(k.label)}</div><div class="adm-kpi-val">${esc(k.val)}</div></div>`).join("");

    const dStatus = counts.deliveriesByStatus || {};
    const statusChips = Object.keys(dStatus).length
      ? `<div class="adm-chips">${Object.entries(dStatus).map(([s, n]) => `<span class="adm-chip">${esc(s)}: ${esc(n)}</span>`).join("")}</div>` : "";

    const TABS = [
      ["overview", "Overview"], ["crm", "CRM Profiles"], ["tags", "Tags"],
      ["deliveries", "Deliveries"], ["replyrate", "Reply Rate"],
      ["hidden", "Hidden Online"], ["followback", "Follow Back"], ["vault", "Vault"],
    ];

    main.innerHTML = `
      <div class="adm-page">
        <div class="adm-detail-head">
          <button class="adm-link" id="admBack">← creators</button>
          <h1>${esc(c.displayName || c.username || c.id)}</h1>
          <div class="adm-detail-sub">
            @${esc(c.username || "—")} ·
            agency <b>${esc(c.agency?.name || "—")}</b> ·
            status <b>${esc(c.status || "—")}</b> ·
            tier <b>${esc(c.billingProfile?.tier || "—")}</b> ·
            <span class="adm-muted">id ${esc(c.id)}</span>
          </div>
        </div>

        <div class="adm-kpi-row">${kpis}</div>
        ${statusChips}

        <div class="adm-tabs">
          ${TABS.map(([k, l]) => `<button class="adm-tab ${local.tab === k ? "active" : ""}" data-tab="${k}">${esc(l)}</button>`).join("")}
        </div>
        <div id="admCDBody"></div>
      </div>`;

    main.querySelector("#admBack").addEventListener("click", () => R().pushSection("creators"));
    main.querySelectorAll(".adm-tab").forEach((b) => b.addEventListener("click", () => { local.tab = b.dataset.tab; paint(main); }));

    const body = main.querySelector("#admCDBody");
    if (local.tab === "overview") renderOverview(body);
    else if (local.tab === "crm") renderList(body, "crm");
    else if (local.tab === "tags") renderList(body, "tags");
    else if (local.tab === "deliveries") renderList(body, "deliveries");
    else if (local.tab === "replyrate") renderReplyRate(body);
    else if (local.tab === "hidden") renderList(body, "hidden");
    else if (local.tab === "followback") renderList(body, "followback");
    else if (local.tab === "vault") renderList(body, "vault");
  }

  function renderOverview(body) {
    const o = local.overview, c = o.creator || {};
    body.innerHTML = `
      <div class="adm-card">
        <div class="adm-card-title">Raw creator record</div>
        <pre class="adm-json">${esc(JSON.stringify({ creator: c, counts: o.counts, bumpStats: o.bumpStats }, null, 2))}</pre>
      </div>`;
  }

  function renderReplyRate(body) {
    body.innerHTML = `<div class="adm-loading">loading…</div>`;
    A().dataBumpStats({ creatorId: local.creatorId }).then((r) => {
      if (!r || !r.ok) { body.innerHTML = `<div class="adm-error">failed</div>`; return; }
      const t = r.totals || {};
      const tpl = (r.perTemplate || []).map((p) => `
        <tr><td>${esc(trunc(p.templateId || "(none)", 24))}</td><td>${esc(p.sent)}</td><td>${esc(p.replied)}</td>
        <td><b>${esc(p.replyRate)}%</b></td><td>${esc(p.canceled)}</td><td>${esc(p.expired)}</td><td>${esc(p.failed)}</td></tr>`).join("");
      body.innerHTML = `
        <div class="adm-kpi-row">
          <div class="adm-kpi"><div class="adm-kpi-label">sent</div><div class="adm-kpi-val">${esc(t.sent || 0)}</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">replied</div><div class="adm-kpi-val">${esc(t.replied || 0)}</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">reply rate</div><div class="adm-kpi-val">${esc(t.replyRate || 0)}%</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">canceled</div><div class="adm-kpi-val">${esc(t.canceled || 0)}</div></div>
          <div class="adm-kpi"><div class="adm-kpi-label">expired</div><div class="adm-kpi-val">${esc(t.expired || 0)}</div></div>
        </div>
        <div class="adm-card">
          <div class="adm-card-title">Reply rate by template (best first)</div>
          <table class="adm-table"><thead><tr><th>Template</th><th>Sent</th><th>Replied</th><th>Reply%</th><th>Canceled</th><th>Expired</th><th>Failed</th></tr></thead>
          <tbody>${tpl || `<tr><td colspan="7" class="adm-muted">no data yet</td></tr>`}</tbody></table>
        </div>`;
    });
  }

  // Generic list renderer for a tab. Defines columns + api per kind.
  function renderList(body, kind) {
    const cfg = listConfig(kind);
    body.innerHTML = `<div class="adm-loading">loading…</div>`;
    cfg.api().then((r) => {
      if (!r || !r.ok) { body.innerHTML = `<div class="adm-error">failed</div>`; return; }
      const items = r.items || [];
      const head = cfg.cols.map((c) => `<th>${esc(c.label)}</th>`).join("");
      const rows = items.map((row) => {
        const tds = cfg.cols.map((c) => `<td title="${esc(typeof row[c.k] === "object" ? JSON.stringify(row[c.k]) : row[c.k])}">${esc(trunc(c.fmt ? c.fmt(row[c.k], row) : (row[c.k] == null ? "—" : row[c.k]), 40))}</td>`).join("");
        return `<tr>${tds}<td class="adm-row-actions"><button class="adm-link" data-inspect="${esc(row.id)}">inspect</button><button class="adm-link adm-link-danger" data-del="${esc(row.id)}">del</button></td></tr>`;
      }).join("");
      body.innerHTML = `
        <div class="adm-muted" style="margin:6px 0">${items.length} shown${r.total != null ? " of " + r.total + " total" : ""}</div>
        <table class="adm-table"><thead><tr>${head}<th></th></tr></thead><tbody>${rows || `<tr><td colspan="99" class="adm-muted">no rows</td></tr>`}</tbody></table>`;
      body.querySelectorAll("[data-inspect]").forEach((b) => b.addEventListener("click", async () => {
        const rr = await A().dataInspect(cfg.model, b.dataset.inspect);
        if (rr?.ok) showModal(`${cfg.model} · ${b.dataset.inspect}`, `<pre class="adm-json">${esc(JSON.stringify(rr.record, null, 2))}</pre>`);
      }));
      body.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
        if (!confirm(`Delete this ${cfg.model}?`)) return;
        const rr = await A().dataDeleteRecord(cfg.model, b.dataset.del);
        R().toast(rr?.ok ? "deleted" : "failed", rr?.ok ? "ok" : "error");
        if (rr?.ok) renderList(body, kind);
      }));
    });
  }

  function listConfig(kind) {
    const cid = local.creatorId;
    switch (kind) {
      case "crm": return {
        model: "crmProfile", api: () => A().crmProfiles({ creatorId: cid, limit: 200 }),
        cols: [{ k: "fanId", label: "Fan" }, { k: "username", label: "Username" }, { k: "name", label: "Name" }, { k: "spenderTier", label: "Tier" }, { k: "fanRole", label: "Role" }, { k: "_count", label: "Tags", fmt: (v) => (v ? v.tags : 0) }, { k: "updatedAt", label: "Updated", fmt: fmtDate }],
      };
      case "tags": return {
        model: "crmProfileTag", api: () => A().crmTags({ creatorId: cid, limit: 300 }),
        cols: [{ k: "label", label: "Label" }, { k: "kind", label: "Kind" }, { k: "category", label: "Category" }, { k: "nicheLevel", label: "Niche" }, { k: "broadcastPolicy", label: "Broadcast" }, { k: "negative", label: "Neg", fmt: (v) => (v ? "yes" : "") }],
      };
      case "deliveries": return {
        model: "automationDelivery", api: () => A().dataDeliveries({ creatorId: cid, limit: 300 }),
        cols: [{ k: "fanId", label: "Fan" }, { k: "status", label: "Status" }, { k: "messageId", label: "MsgId" }, { k: "priceCents", label: "Price", fmt: fmtMoney }, { k: "sentAt", label: "Sent", fmt: fmtDate }],
      };
      case "hidden": return {
        model: "hiddenOnlineUser", api: () => A().dataHiddenOnline({ creatorId: cid, limit: 300 }),
        cols: [{ k: "fanId", label: "Fan" }, { k: "username", label: "Username" }, { k: "status", label: "Status" }, { k: "totalSpentCents", label: "Spent", fmt: fmtMoney }, { k: "lastSignalAt", label: "Last signal", fmt: fmtDate }],
      };
      case "followback": return {
        model: "followBackTask", api: () => A().dataFollowBack({ creatorId: cid, limit: 300 }),
        cols: [{ k: "fanId", label: "Fan" }, { k: "username", label: "Username" }, { k: "action", label: "Action" }, { k: "status", label: "Status" }, { k: "updatedAt", label: "Updated", fmt: fmtDate }],
      };
      case "vault": return {
        model: "vaultMediaSale", api: () => A().dataVaultSales({ creatorId: cid, limit: 300 }),
        cols: [{ k: "messageId", label: "MsgId" }, { k: "mediaId", label: "Media" }, { k: "status", label: "Status" }, { k: "allocatedAmountCents", label: "Amount", fmt: fmtMoney }, { k: "purchasedAt", label: "Purchased", fmt: fmtDate }],
      };
      default: return { model: "crmProfile", api: () => A().crmProfiles({ creatorId: cid }), cols: [] };
    }
  }

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

  window.OnlinodAdminCreatorDetail = { render };
})();
