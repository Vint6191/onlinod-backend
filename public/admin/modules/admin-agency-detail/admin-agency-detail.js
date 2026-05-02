/* public/admin/modules/admin-agency-detail/admin-agency-detail.js
   ────────────────────────────────────────────────────────────
   Single-agency drill-down page.
   
   On render:
     1. Reads agencyId from state.sectionParam.
     2. Loads via GET /api/admin/agencies/:id (cached 30s per id).
     3. Renders header (back button, name+id, status pill, action
        buttons) and a tab strip.
     4. Dispatches to the active tab's renderer.
   
   Tabs: overview | members | creators | subscription | audit
   
   We split tab renderers into separate files because each has its
   own logic + actions — keeping them together would make this
   file unmanageable.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const State = () => window.OnlinodAdminState;
  const StateApi = () => window.OnlinodAdminStateApi;
  const A     = () => window.OnlinodAdminApi;
  const R     = () => window.OnlinodAdminRouter;
  const U     = () => window.OnlinodAdminUtils;

  const TABS = [
    { key: "overview",     label: "Overview" },
    { key: "members",      label: "Members" },
    { key: "creators",     label: "Creators" },
    { key: "subscription", label: "Subscription" },
    { key: "audit",        label: "Audit" },
  ];

  function currentSlice() {
    const id = State().sectionParam;
    if (!id) return null;
    return StateApi().ensureAgencyDetail(id);
  }

  async function load(force) {
    const id = State().sectionParam;
    if (!id) return;

    const slice = StateApi().ensureAgencyDetail(id);
    if (slice.loading) return;
    if (!force && slice.data && Date.now() - slice.lastLoadedAt < 30_000) return;

    slice.loading = true;
    slice.error = null;
    rerender();

    const result = await A().getAgency(id);
    slice.loading = false;

    if (!result?.ok) {
      slice.error = result?.error || "Failed to load agency";
      slice.data = null;
    } else {
      slice.data = result;
      slice.lastLoadedAt = Date.now();
    }

    rerender();
  }

  function rerender() {
    const main = document.getElementById("admMain");
    if (main) render(main);
  }

  function render(main) {
    const id = State().sectionParam;
    if (!id) {
      main.innerHTML = `
        <div class="adm-error">No agency id in URL.</div>
        <button class="adm-btn" data-back-to-agencies>← back to agencies</button>
      `;
      main.querySelector("[data-back-to-agencies]")
          ?.addEventListener("click", () => R().pushSection("agencies"));
      return;
    }

    const slice = StateApi().ensureAgencyDetail(id);
    const r = R();
    const u = U();

    // Auto-load.
    if (!slice.data && !slice.loading && !slice.error) {
      load(false);
    }

    if (slice.loading && !slice.data) {
      main.innerHTML = `
        ${renderBackBar(id)}
        <div class="adm-loading">loading agency…</div>
      `;
      bindBackBar(main);
      return;
    }

    if (slice.error && !slice.data) {
      main.innerHTML = `
        ${renderBackBar(id)}
        <div class="adm-error">${r.escapeHtml(slice.error)}</div>
        <button class="adm-btn" id="admAgDetailRetry">↻ retry</button>
      `;
      bindBackBar(main);
      main.querySelector("#admAgDetailRetry")?.addEventListener("click", () => load(true));
      return;
    }

    if (!slice.data) return;

    const a = slice.data.agency;
    const tab = slice.tab || "overview";

    main.innerHTML = `
      ${renderBackBar(id)}
      ${renderHeader(slice)}
      ${renderTabStrip(slice)}

      <div id="admAgDetailTabBody">
        ${renderTabBody(slice, tab)}
      </div>
    `;

    bindBackBar(main);
    bindHeader(main, slice);
    bindTabStrip(main, slice);
    bindTabBody(main, slice, tab);
  }

  function renderBackBar(id) {
    const r = R();
    return `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        <button class="adm-btn ghost" data-back-to-agencies>← Agencies</button>
        <div style="
          font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);
        ">~/admin/agencies/${r.escapeHtml(id)}</div>
      </div>
    `;
  }

  function bindBackBar(main) {
    main.querySelector("[data-back-to-agencies]")
        ?.addEventListener("click", () => R().pushSection("agencies"));
  }

  function renderHeader(slice) {
    const r = R();
    const u = U();
    const a = slice.data.agency;
    const h = slice.data.health;

    const isDeleted = !!a.deletedAt;
    const owner = (a.members || []).find((m) => m.role === "OWNER");

    return `
      <div class="adm-page-head">
        <div style="display:flex;align-items:center;gap:14px;min-width:0;">
          ${u.letterAvatar(a.name, 44)}

          <div style="min-width:0;">
            <div style="display:flex;align-items:center;gap:10px;">
              <div class="adm-page-title">${r.escapeHtml(a.name || "—")}</div>
              ${u.statusPill(a.status)}
              ${isDeleted ? `<span class="adm-pill crit no-dot">deleted</span>` : ""}
            </div>
            <div class="adm-page-subtitle">
              ${r.escapeHtml(a.id)}
              · created ${r.escapeHtml(u.formatDate(a.createdAt))}
              ${owner ? `· owner ${r.escapeHtml(owner.user?.email || "—")}` : ""}
              ${h ? ` · health ${r.escapeHtml(String(h.score))}/100` : ""}
            </div>
          </div>
        </div>

        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          ${
            isDeleted
              ? `<button class="adm-btn primary" data-action="restore">↺ restore</button>`
              : `<button class="adm-btn" data-action="impersonate">⮕ impersonate owner</button>`
          }

          ${
            !isDeleted
              ? `<button class="adm-btn danger" data-action="soft-delete">delete agency…</button>`
              : `<button class="adm-btn danger" data-action="hard-delete">hard delete…</button>`
          }

          <button class="adm-btn ghost" data-action="refresh">↻</button>
        </div>
      </div>

      ${
        isDeleted
          ? `<div class="adm-error" style="margin-bottom:14px;">
              This agency was soft-deleted${a.deletedReason ? `: ${r.escapeHtml(a.deletedReason)}` : ""}.
              Restore to reactivate, or hard delete to remove forever.
            </div>`
          : ""
      }

      ${renderHealthIssues(slice)}
    `;
  }

  function renderHealthIssues(slice) {
    const r = R();
    const issues = slice.data.health?.issues || [];
    if (!issues.length) return "";

    return `
      <div class="adm-card" style="margin-bottom:14px;">
        <div class="adm-card-head">
          <div class="adm-card-title">Health · ${r.escapeHtml(String(issues.length))} issue${issues.length === 1 ? "" : "s"}</div>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;">
          ${issues.slice(0, 8).map((i) => `
            <div style="
              display:flex;align-items:center;gap:10px;
              padding:8px 10px;border-radius:6px;
              background:${i.severity === "ERROR" ? "var(--adm-red-soft)" : "var(--adm-amber-soft)"};
            ">
              <span class="adm-pill ${i.severity === "ERROR" ? "crit" : "warn"} no-dot">
                ${r.escapeHtml(i.severity.toLowerCase())}
              </span>
              <span style="flex:1;">${r.escapeHtml(i.message)}</span>
              <span style="font-family:var(--adm-mono);font-size:10px;color:var(--adm-muted);">
                ${r.escapeHtml(i.targetType)}
              </span>
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  function bindHeader(main, slice) {
    main.querySelectorAll("[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const action = btn.dataset.action;
        const a = slice.data.agency;

        if (action === "refresh") return load(true);
        if (action === "impersonate")  return window.OnlinodAdminAgencyDetailActions.doImpersonate(a.id);
        if (action === "soft-delete")  return window.OnlinodAdminAgencyDetailActions.doSoftDelete(a.id);
        if (action === "hard-delete")  return window.OnlinodAdminAgencyDetailActions.doHardDelete(a.id);
        if (action === "restore")      return window.OnlinodAdminAgencyDetailActions.doRestore(a.id);
      });
    });
  }

  function renderTabStrip(slice) {
    const r = R();
    const tab = slice.tab || "overview";
    const a = slice.data.agency;

    const counts = {
      members:      (a.members || []).length,
      creators:     (a.creators || []).filter((c) => !c.deletedAt).length,
      subscription: (a.subscriptions || []).length,
      audit:        (a.adminActionLogs || []).length,
    };

    const items = TABS.map((t) => {
      const c = counts[t.key];
      return `
        <button
          class="adm-rail-item ${t.key === tab ? "active" : ""}"
          data-agtab="${r.escapeAttr(t.key)}"
          style="display:inline-flex;width:auto;"
        >
          <span>${r.escapeHtml(t.label)}</span>
          ${c !== undefined ? `<span class="adm-rail-item-badge">${r.escapeHtml(String(c))}</span>` : ""}
        </button>
      `;
    }).join("");

    return `
      <div style="
        display:flex;gap:6px;flex-wrap:wrap;
        padding:6px;border-radius:10px;background:var(--adm-panel-2);
        border:1px solid var(--adm-line);margin-bottom:14px;
      ">
        ${items}
      </div>
    `;
  }

  function bindTabStrip(main, slice) {
    main.querySelectorAll("[data-agtab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        slice.tab = btn.dataset.agtab;
        rerender();
      });
    });
  }

  function renderTabBody(slice, tab) {
    if (tab === "overview")     return window.OnlinodAdminAgencyDetailOverview.render(slice);
    if (tab === "members")      return window.OnlinodAdminAgencyDetailTabs.renderMembers(slice);
    if (tab === "creators")     return window.OnlinodAdminAgencyDetailTabs.renderCreators(slice);
    if (tab === "subscription") return window.OnlinodAdminAgencyDetailTabs.renderSubscription(slice);
    if (tab === "audit")        return window.OnlinodAdminAgencyDetailTabs.renderAudit(slice);
    return `<div class="adm-empty">unknown tab</div>`;
  }

  function bindTabBody(main, slice, tab) {
    if (tab === "overview")     window.OnlinodAdminAgencyDetailOverview.bind?.(main, slice);
    if (tab === "members")      window.OnlinodAdminAgencyDetailTabs.bindMembers?.(main, slice);
    if (tab === "creators")     window.OnlinodAdminAgencyDetailTabs.bindCreators?.(main, slice);
    if (tab === "subscription") window.OnlinodAdminAgencyDetailTabs.bindSubscription?.(main, slice);
    if (tab === "audit")        window.OnlinodAdminAgencyDetailTabs.bindAudit?.(main, slice);
  }

  window.OnlinodAdminAgencyDetail = { render, load, rerender };
})();
