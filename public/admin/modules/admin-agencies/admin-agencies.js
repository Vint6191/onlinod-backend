/* public/admin/modules/admin-agencies/admin-agencies.js
   ────────────────────────────────────────────────────────────
   List of all agencies. Filters:
     - search (q) — by name (client-side, instant)
     - status filter — all/trial/active/past_due/locked
     - includeDeleted — show soft-deleted
   
   Each row click opens agency detail (заход 3 will implement).
   Per-row actions:
     - impersonate as owner → opens new tab with magic URL
   
   We deliberately don't paginate — agencies count is small enough
   that one fetch is fine. We'll add cursor pagination if it ever
   matters.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const State = () => window.OnlinodAdminState;
  const A     = () => window.OnlinodAdminApi;
  const R     = () => window.OnlinodAdminRouter;
  const U     = () => window.OnlinodAdminUtils;

  function ensureSlice() {
    const s = State();
    if (!s.agencies) {
      s.agencies = {
        loading: false,
        error: null,
        list: [],
        filters: { q: "", includeDeleted: false, statusFilter: "all" },
        lastLoadedAt: 0,
      };
    }
    return s.agencies;
  }

  async function load(force) {
    const slice = ensureSlice();
    if (slice.loading) return;
    if (!force && slice.list.length && Date.now() - slice.lastLoadedAt < 30_000) return;

    slice.loading = true;
    slice.error = null;
    rerender();

    const result = await A().listAgencies({
      includeDeleted: slice.filters.includeDeleted ? "1" : undefined,
    });

    slice.loading = false;
    if (!result?.ok) {
      slice.error = result?.error || "Failed to load agencies";
      slice.list = [];
    } else {
      slice.list = Array.isArray(result.agencies) ? result.agencies : [];
      slice.lastLoadedAt = Date.now();
    }

    rerender();
  }

  function rerender() {
    const main = document.getElementById("admMain");
    if (main) render(main);
  }

  function applyClientFilters(list, filters) {
    let out = list;

    if (filters.q) {
      const needle = filters.q.toLowerCase();
      out = out.filter((a) =>
        String(a.name || "").toLowerCase().includes(needle) ||
        String(a.id || "").toLowerCase().includes(needle) ||
        String(a.owner?.email || "").toLowerCase().includes(needle)
      );
    }

    if (filters.statusFilter && filters.statusFilter !== "all") {
      out = out.filter((a) => String(a.status || "").toUpperCase() === filters.statusFilter);
    }

    return out;
  }

  function render(main) {
    const slice = ensureSlice();
    const r = R();
    const u = U();

    // Auto-load on first render.
    if (!slice.list.length && !slice.loading && !slice.error) {
      load(false);
    }

    const filtered = applyClientFilters(slice.list, slice.filters);

    main.innerHTML = `
      <div class="adm-page-head">
        <div>
          <div class="adm-page-title">Agencies</div>
          <div class="adm-page-subtitle">~/admin/agencies · ${r.escapeHtml(String(filtered.length))}/${r.escapeHtml(String(slice.list.length))}</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="adm-btn ghost" id="admAgRefresh">↻ refresh</button>
        </div>
      </div>

      ${slice.error ? `<div class="adm-error">${r.escapeHtml(slice.error)}</div>` : ""}

      <div class="adm-table-wrap">
        <div class="adm-table-toolbar">
          <input
            class="adm-input"
            id="admAgSearch"
            placeholder="search by name, id, owner email…"
            value="${r.escapeAttr(slice.filters.q)}"
            style="min-width:280px;"
          >

          <select class="adm-select" id="admAgStatus">
            <option value="all">all status</option>
            <option value="TRIAL">trial</option>
            <option value="ACTIVE">active</option>
            <option value="GRACE">grace</option>
            <option value="PAST_DUE">past due</option>
            <option value="LOCKED">locked</option>
            <option value="CANCELLED">cancelled</option>
          </select>

          <label style="display:flex;align-items:center;gap:6px;font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);cursor:pointer;">
            <input type="checkbox" id="admAgIncludeDeleted" ${slice.filters.includeDeleted ? "checked" : ""}>
            include deleted
          </label>

          <div class="adm-table-toolbar-spacer"></div>

          <span style="color:var(--adm-muted);font-family:var(--adm-mono);font-size:11px;">
            ${slice.loading ? "loading…" : (slice.lastLoadedAt ? `loaded ${u.timeAgo(slice.lastLoadedAt)}` : "")}
          </span>
        </div>

        ${
          slice.loading && !slice.list.length
            ? `<div class="adm-loading">loading agencies…</div>`
            : !filtered.length
            ? `<div class="adm-empty">${slice.list.length ? "No matches for current filters." : "No agencies yet."}</div>`
            : `
              <table class="adm-table">
                <thead>
                  <tr>
                    <th>name</th>
                    <th>owner</th>
                    <th>status</th>
                    <th>creators</th>
                    <th>members</th>
                    <th>snapshots</th>
                    <th>health</th>
                    <th>created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${filtered.map(renderRow).join("")}
                </tbody>
              </table>
            `
        }
      </div>
    `;

    // Restore status select value (set after innerHTML).
    const statusSel = main.querySelector("#admAgStatus");
    if (statusSel) statusSel.value = slice.filters.statusFilter || "all";

    bind(main);
  }

  function renderRow(a) {
    const r = R();
    const u = U();

    const ownerEmail = a.owner?.email || "—";
    const isDeleted = !!a.deletedAt;

    return `
      <tr ${isDeleted ? `class="muted"` : ""} data-agency-id="${r.escapeAttr(a.id)}">
        <td>
          <div class="adm-cell-name">
            ${u.letterAvatar(a.name, 28)}
            <div class="adm-cell-name-main">
              <div class="adm-cell-name-strong">${r.escapeHtml(a.name || "—")}</div>
              <div class="adm-cell-name-sub">${r.escapeHtml(a.id)}</div>
            </div>
          </div>
        </td>

        <td class="adm-cell-mono">${r.escapeHtml(ownerEmail)}</td>

        <td>${u.statusPill(a.status)}${isDeleted ? `<span class="adm-pill crit no-dot" style="margin-left:6px;">deleted</span>` : ""}</td>

        <td class="adm-cell-num">
          ${r.escapeHtml(String(a.counts?.readyCreators || 0))}
          <span style="color:var(--adm-muted);">/${r.escapeHtml(String(a.counts?.creators || 0))}</span>
        </td>

        <td class="adm-cell-num">${r.escapeHtml(String(a.counts?.members || 0))}</td>

        <td class="adm-cell-num">${r.escapeHtml(String(a.counts?.activeSnapshots || 0))}</td>

        <td>${u.healthBadge(a.health)}</td>

        <td class="adm-cell-mono">${r.escapeHtml(u.formatDate(a.createdAt))}</td>

        <td onclick="event.stopPropagation()">
          <button class="adm-btn ghost" data-impersonate="${r.escapeAttr(a.id)}" title="open as owner in a new tab">⮕ impersonate</button>
        </td>
      </tr>
    `;
  }

  async function doImpersonate(agencyId) {
    const result = await A().impersonate(agencyId, {});
    if (!result?.ok) {
      R().toast(result?.error || "Impersonate failed");
      return;
    }
    // Open in new tab. The page at "/" claims the token via /api/impersonate/claim.
    window.open(result.url, "_blank", "noopener");
    R().toast(`impersonating ${result.target?.userEmail || "owner"}`);
  }

  function bind(main) {
    main.querySelector("#admAgRefresh")?.addEventListener("click", () => load(true));

    const slice = ensureSlice();

    const search = main.querySelector("#admAgSearch");
    if (search) {
      search.addEventListener("input", (e) => {
        slice.filters.q = e.target.value;
        rerender();
      });
    }

    const status = main.querySelector("#admAgStatus");
    if (status) {
      status.addEventListener("change", (e) => {
        slice.filters.statusFilter = e.target.value;
        rerender();
      });
    }

    const includeDel = main.querySelector("#admAgIncludeDeleted");
    if (includeDel) {
      includeDel.addEventListener("change", (e) => {
        slice.filters.includeDeleted = e.target.checked;
        load(true);
      });
    }

    // Row click → open detail.
    main.querySelectorAll("tbody tr[data-agency-id]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const id = tr.dataset.agencyId;
        if (id) R().pushAgencyDetail(id);
      });
    });

    // Impersonate buttons.
    main.querySelectorAll("[data-impersonate]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.dataset.impersonate;
        if (id) doImpersonate(id);
      });
    });
  }

  window.OnlinodAdminAgencies = { render };
})();
