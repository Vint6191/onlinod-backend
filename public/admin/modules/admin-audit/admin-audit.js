/* public/admin/modules/admin-audit/admin-audit.js
   ────────────────────────────────────────────────────────────
   Global audit log search.
   
   Backend GET /api/admin/audit returns a single combined feed:
     - admin actions (AdminActionLog): kind="admin"
     - user audit logs (AuditLog):     kind="user"
   
   Filters:
     q          — substring match on action/targetId/agencyId
                  (server applies on the merged feed)
     agencyId   — narrow to one agency
     action     — substring on action name (e.g. "delete", "billing")
     targetType — "agency" | "user" | "creator" | "member" | "device" | …
     before     — ISO datetime
     after      — ISO datetime
     limit      — default 100, max 500
   
   Each row shows time, kind pill, actor, action, target. Click
   "view" → modal with the full before/after JSON diff.
   
   We intentionally do not paginate — admin tools don't get heavy
   enough for that to matter, and limit=500 covers anything
   realistic. Date filters narrow further when needed.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;
  const U = () => window.OnlinodAdminUtils;

  // Local module state — no slice in the global state object since
  // audit is the only place this data lives.
  const state = {
    loading: false,
    error: null,
    events: [],
    filters: {
      q: "",
      agencyId: "",
      action: "",
      targetType: "",
      before: "",
      after: "",
      limit: 100,
    },
    lastLoadedAt: 0,
  };

  async function load(force) {
    if (state.loading) return;
    if (!force && state.events.length && Date.now() - state.lastLoadedAt < 30_000) return;

    state.loading = true;
    state.error = null;
    rerender();

    const f = state.filters;
    const result = await A().audit({
      q:          f.q || undefined,
      agencyId:   f.agencyId || undefined,
      action:     f.action || undefined,
      targetType: f.targetType || undefined,
      before:     f.before || undefined,
      after:      f.after || undefined,
      limit:      f.limit || 100,
    });

    state.loading = false;
    if (!result?.ok) {
      state.error = result?.error || "Failed to load audit";
      state.events = [];
    } else {
      state.events = Array.isArray(result.events) ? result.events : [];
      state.lastLoadedAt = Date.now();
    }
    rerender();
  }

  function rerender() {
    const main = document.getElementById("admMain");
    if (main) render(main);
  }

  function render(main) {
    const r = R();
    const u = U();

    if (!state.events.length && !state.loading && !state.error) load(false);

    main.innerHTML = `
      <div class="adm-page-head">
        <div>
          <div class="adm-page-title">Audit</div>
          <div class="adm-page-subtitle">~/admin/audit · ${r.escapeHtml(String(state.events.length))} events</div>
        </div>
        <button class="adm-btn ghost" id="admAuditRefresh">↻ refresh</button>
      </div>

      ${state.error ? `<div class="adm-error">${r.escapeHtml(state.error)}</div>` : ""}

      <div class="adm-table-wrap">
        <div class="adm-table-toolbar" style="flex-wrap:wrap;">
          <input class="adm-input" id="admAuditQ" placeholder="search action / target / agency…"
                 value="${r.escapeAttr(state.filters.q)}" style="min-width:240px;">

          <input class="adm-input mono" id="admAuditAgency" placeholder="agency id"
                 value="${r.escapeAttr(state.filters.agencyId)}" style="min-width:160px;">

          <select class="adm-select" id="admAuditTargetType">
            <option value="">all targets</option>
            <option value="agency">agency</option>
            <option value="user">user</option>
            <option value="member">member</option>
            <option value="creator">creator</option>
            <option value="device">device</option>
            <option value="admin">admin</option>
          </select>

          <input class="adm-input mono" id="admAuditAction" placeholder="action contains…"
                 value="${r.escapeAttr(state.filters.action)}" style="min-width:160px;">

          <input class="adm-input mono" id="admAuditAfter" placeholder="after (ISO)"
                 value="${r.escapeAttr(state.filters.after)}" style="min-width:170px;">

          <input class="adm-input mono" id="admAuditBefore" placeholder="before (ISO)"
                 value="${r.escapeAttr(state.filters.before)}" style="min-width:170px;">

          <div class="adm-table-toolbar-spacer"></div>

          <span style="color:var(--adm-muted);font-family:var(--adm-mono);font-size:11px;">
            ${state.loading ? "loading…" : (state.lastLoadedAt ? `loaded ${u.timeAgo(state.lastLoadedAt)}` : "")}
          </span>
        </div>

        ${
          state.loading && !state.events.length
            ? `<div class="adm-loading">loading audit…</div>`
            : !state.events.length
            ? `<div class="adm-empty">No events match these filters.</div>`
            : `
              <table class="adm-table">
                <thead>
                  <tr>
                    <th>time</th>
                    <th>kind</th>
                    <th>action</th>
                    <th>actor</th>
                    <th>target</th>
                    <th>agency</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${state.events.map(renderRow).join("")}
                </tbody>
              </table>
            `
        }
      </div>

      <div id="admAuditModal"></div>
    `;

    // Restore selects after innerHTML.
    const sel = main.querySelector("#admAuditTargetType");
    if (sel) sel.value = state.filters.targetType || "";

    bind(main);
  }

  function renderRow(e) {
    const r = R();
    const u = U();

    const actor = e.actorAdminId
      ? `<span class="adm-pill warn no-dot" title="admin">admin</span> ${r.escapeHtml(String(e.actorAdminId).slice(-8))}`
      : e.actorUserId
      ? `<span class="adm-pill info no-dot" title="user">user</span> ${r.escapeHtml(String(e.actorUserId).slice(-8))}`
      : `<span style="color:var(--adm-muted);">system</span>`;

    const target = e.targetType
      ? `<span class="adm-pill muted no-dot">${r.escapeHtml(e.targetType)}</span> ${r.escapeHtml(String(e.targetId || "").slice(-10))}`
      : "—";

    return `
      <tr data-audit-id="${r.escapeAttr(e.id)}">
        <td class="adm-cell-mono" style="white-space:nowrap;">${r.escapeHtml(u.formatDateTime(e.createdAt))}</td>
        <td>
          <span class="adm-pill ${e.kind === "admin" ? "warn" : "info"} no-dot">
            ${r.escapeHtml(e.kind)}
          </span>
        </td>
        <td class="adm-cell-mono">${r.escapeHtml(e.action)}</td>
        <td class="adm-cell-mono" style="white-space:nowrap;">${actor}</td>
        <td class="adm-cell-mono" style="white-space:nowrap;">${target}</td>
        <td class="adm-cell-mono">${e.agencyId ? r.escapeHtml(String(e.agencyId).slice(-8)) : "—"}</td>
        <td>
          <button class="adm-btn ghost" data-audit-show="${r.escapeAttr(e.id)}">view</button>
        </td>
      </tr>
    `;
  }

  function bind(main) {
    main.querySelector("#admAuditRefresh")?.addEventListener("click", () => load(true));

    let qTimer = null, aTimer = null, actTimer = null;

    main.querySelector("#admAuditQ")?.addEventListener("input", (e) => {
      state.filters.q = e.target.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => load(true), 300);
    });

    main.querySelector("#admAuditAgency")?.addEventListener("input", (e) => {
      state.filters.agencyId = e.target.value;
      clearTimeout(aTimer);
      aTimer = setTimeout(() => load(true), 300);
    });

    main.querySelector("#admAuditAction")?.addEventListener("input", (e) => {
      state.filters.action = e.target.value;
      clearTimeout(actTimer);
      actTimer = setTimeout(() => load(true), 300);
    });

    main.querySelector("#admAuditTargetType")?.addEventListener("change", (e) => {
      state.filters.targetType = e.target.value;
      load(true);
    });

    main.querySelector("#admAuditBefore")?.addEventListener("change", (e) => {
      state.filters.before = e.target.value;
      load(true);
    });

    main.querySelector("#admAuditAfter")?.addEventListener("change", (e) => {
      state.filters.after = e.target.value;
      load(true);
    });

    // View diff modal
    main.querySelectorAll("[data-audit-show]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = btn.dataset.auditShow;
        const evt = state.events.find((x) => x.id === id);
        if (evt) openModal(evt);
      });
    });

    // Row click jumps to agency detail if there's an agency.
    main.querySelectorAll("tbody tr[data-audit-id]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const id = tr.dataset.auditId;
        const evt = state.events.find((x) => x.id === id);
        if (evt?.agencyId) R().pushAgencyDetail(evt.agencyId);
      });
    });
  }

  function openModal(evt) {
    const r = R();
    const u = U();
    const slot = document.getElementById("admAuditModal");
    if (!slot) return;

    const meta = evt.metadata || {};

    slot.innerHTML = `
      <div class="adm-drawer-backdrop" data-modal-close></div>
      <aside class="adm-drawer" style="width:min(720px,96vw);">
        <div class="adm-drawer-head">
          <div class="adm-drawer-title">Event diff</div>
          <button class="adm-btn ghost" data-modal-close>×</button>
        </div>
        <div class="adm-drawer-body">
          <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px 16px;
                      font-family:var(--adm-mono);font-size:11.5px;margin-bottom:14px;">
            <div><span style="color:var(--adm-muted);">time</span><br>${r.escapeHtml(u.formatDateTime(evt.createdAt))}</div>
            <div><span style="color:var(--adm-muted);">kind</span><br>${r.escapeHtml(evt.kind)}</div>
            <div><span style="color:var(--adm-muted);">action</span><br>${r.escapeHtml(evt.action)}</div>
            <div><span style="color:var(--adm-muted);">target</span><br>${r.escapeHtml(evt.targetType || "—")} ${r.escapeHtml(evt.targetId || "")}</div>
            <div><span style="color:var(--adm-muted);">actor admin</span><br>${r.escapeHtml(evt.actorAdminId || "—")}</div>
            <div><span style="color:var(--adm-muted);">actor user</span><br>${r.escapeHtml(evt.actorUserId || "—")}</div>
            <div style="grid-column:1/-1;"><span style="color:var(--adm-muted);">agency</span><br>${r.escapeHtml(evt.agencyId || "—")}</div>
            ${meta.reason ? `<div style="grid-column:1/-1;"><span style="color:var(--adm-muted);">reason</span><br>${r.escapeHtml(meta.reason)}</div>` : ""}
          </div>

          <div class="adm-card-title" style="margin-bottom:6px;">Before</div>
          <pre style="
            background:rgba(0,0,0,0.32);border:1px solid var(--adm-line);
            border-radius:6px;padding:10px;font-family:var(--adm-mono);
            font-size:11px;overflow:auto;max-height:240px;color:var(--adm-text-soft);
          ">${r.escapeHtml(JSON.stringify(meta.before ?? null, null, 2))}</pre>

          <div class="adm-card-title" style="margin:12px 0 6px;">After</div>
          <pre style="
            background:rgba(0,0,0,0.32);border:1px solid var(--adm-line);
            border-radius:6px;padding:10px;font-family:var(--adm-mono);
            font-size:11px;overflow:auto;max-height:240px;color:var(--adm-text-soft);
          ">${r.escapeHtml(JSON.stringify(meta.after ?? null, null, 2))}</pre>
        </div>
      </aside>
    `;

    slot.querySelectorAll("[data-modal-close]").forEach((el) => {
      el.addEventListener("click", () => { slot.innerHTML = ""; });
    });
  }

  window.OnlinodAdminAudit = { render };
})();
