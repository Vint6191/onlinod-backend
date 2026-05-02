/* public/admin/modules/admin-creators/admin-creators.js
   ────────────────────────────────────────────────────────────
   Cross-agency creators listing.
   
   Filters:
     q           — search by displayName, username, remoteId
     status      — DRAFT/READY/NOT_CREATOR/AUTH_FAILED/DISABLED
     tier        — STARTER/GROWTH/PRO/ELITE/CUSTOM
     agencyId    — filter to one agency
     no_snapshot — only those without active access snapshot
   
   No detail drawer for creators — clicking a creator jumps to
   its agency detail page (the Creators tab there shows it
   in context with billing options).
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const State = () => window.OnlinodAdminState;
  const A     = () => window.OnlinodAdminApi;
  const R     = () => window.OnlinodAdminRouter;
  const U     = () => window.OnlinodAdminUtils;

  function slice() { return State().creators; }

  async function load(force) {
    const s = slice();
    if (s.loading) return;
    if (!force && s.list.length && Date.now() - s.lastLoadedAt < 30_000) return;

    s.loading = true;
    s.error = null;
    rerender();

    const result = await A().listCreators({
      q:            s.filters.q || undefined,
      status:       s.filters.status || undefined,
      tier:         s.filters.tier || undefined,
      agencyId:     s.filters.agencyId || undefined,
      no_snapshot:  s.filters.no_snapshot ? "1" : undefined,
    });

    s.loading = false;
    if (!result?.ok) {
      s.error = result?.error || "Failed to load creators";
      s.list = [];
    } else {
      s.list = Array.isArray(result.creators) ? result.creators : [];
      s.lastLoadedAt = Date.now();
    }
    rerender();
  }

  function rerender() {
    const main = document.getElementById("admMain");
    if (main) render(main);
  }

  function render(main) {
    const s = slice();
    const r = R();
    const u = U();

    if (!s.list.length && !s.loading && !s.error) load(false);

    main.innerHTML = `
      <div class="adm-page-head">
        <div>
          <div class="adm-page-title">Creators</div>
          <div class="adm-page-subtitle">~/admin/creators · ${r.escapeHtml(String(s.list.length))} loaded</div>
        </div>
        <button class="adm-btn ghost" id="admCreatorsRefresh">↻ refresh</button>
      </div>

      ${s.error ? `<div class="adm-error">${r.escapeHtml(s.error)}</div>` : ""}

      <div class="adm-table-wrap">
        <div class="adm-table-toolbar">
          <input class="adm-input" id="admCreatorsQ"
                 placeholder="search by name, username, remote id…"
                 value="${r.escapeAttr(s.filters.q)}" style="min-width:240px;">

          <select class="adm-select" id="admCreatorsStatus">
            <option value="">all status</option>
            <option value="DRAFT">draft</option>
            <option value="READY">ready</option>
            <option value="NOT_CREATOR">not creator</option>
            <option value="AUTH_FAILED">auth failed</option>
            <option value="DISABLED">disabled</option>
          </select>

          <select class="adm-select" id="admCreatorsTier">
            <option value="">all tiers</option>
            <option value="STARTER">starter</option>
            <option value="GROWTH">growth</option>
            <option value="PRO">pro</option>
            <option value="ELITE">elite</option>
            <option value="CUSTOM">custom</option>
          </select>

          <label class="adm-toolbar-check">
            <input type="checkbox" id="admCreatorsNoSnap" ${s.filters.no_snapshot ? "checked" : ""}>
            no snapshot
          </label>

          <div class="adm-table-toolbar-spacer"></div>

          <span style="color:var(--adm-muted);font-family:var(--adm-mono);font-size:11px;">
            ${s.loading ? "loading…" : (s.lastLoadedAt ? `loaded ${u.timeAgo(s.lastLoadedAt)}` : "")}
          </span>
        </div>

        ${
          s.loading && !s.list.length
            ? `<div class="adm-loading">loading creators…</div>`
            : !s.list.length
            ? `<div class="adm-empty">No creators match these filters.</div>`
            : `
              <table class="adm-table">
                <thead>
                  <tr>
                    <th>creator</th>
                    <th>agency</th>
                    <th>status</th>
                    <th>tier</th>
                    <th>snapshot</th>
                    <th>revenue 30d</th>
                    <th>created</th>
                  </tr>
                </thead>
                <tbody>
                  ${s.list.map(renderRow).join("")}
                </tbody>
              </table>
            `
        }
      </div>
    `;

    // Restore selects
    const sel1 = main.querySelector("#admCreatorsStatus");
    if (sel1) sel1.value = s.filters.status || "";
    const sel2 = main.querySelector("#admCreatorsTier");
    if (sel2) sel2.value = s.filters.tier || "";

    bind(main);
  }

  function renderRow(c) {
    const r = R();
    const u = U();

    return `
      <tr data-agency-id="${r.escapeAttr(c.agencyId)}">
        <td>
          <div class="adm-cell-name">
            ${u.letterAvatar(c.displayName, 26)}
            <div class="adm-cell-name-main">
              <div class="adm-cell-name-strong">${r.escapeHtml(c.displayName || "—")}</div>
              <div class="adm-cell-name-sub">
                ${c.username ? "@" + r.escapeHtml(c.username) : r.escapeHtml(c.id.slice(-10))}
                ${c.remoteId ? ` · id ${r.escapeHtml(c.remoteId)}` : ""}
              </div>
            </div>
          </div>
        </td>
        <td class="adm-cell-mono">${r.escapeHtml(c.agencyName || c.agencyId)}</td>
        <td>${u.statusPill(c.status)}</td>
        <td class="adm-cell-mono">
          ${
            c.billingTier
              ? r.escapeHtml(c.billingTier.toLowerCase())
              : `<span style="color:var(--adm-muted);">none</span>`
          }
          ${c.billingExcluded ? `<span class="adm-pill muted no-dot" style="margin-left:6px;">excluded</span>` : ""}
        </td>
        <td>
          ${
            c.hasActiveSnapshot
              ? `<span class="adm-pill ok no-dot">active</span>`
              : `<span class="adm-pill warn no-dot">none</span>`
          }
        </td>
        <td class="adm-cell-num">${r.escapeHtml(u.formatMoneyFromCents(c.revenue30dCents))}</td>
        <td class="adm-cell-mono">${r.escapeHtml(u.formatDate(c.createdAt))}</td>
      </tr>
    `;
  }

  function bind(main) {
    main.querySelector("#admCreatorsRefresh")?.addEventListener("click", () => load(true));

    const s = slice();
    let qTimer = null;

    main.querySelector("#admCreatorsQ")?.addEventListener("input", (e) => {
      s.filters.q = e.target.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => load(true), 250);
    });

    main.querySelector("#admCreatorsStatus")?.addEventListener("change", (e) => {
      s.filters.status = e.target.value;
      load(true);
    });

    main.querySelector("#admCreatorsTier")?.addEventListener("change", (e) => {
      s.filters.tier = e.target.value;
      load(true);
    });

    main.querySelector("#admCreatorsNoSnap")?.addEventListener("change", (e) => {
      s.filters.no_snapshot = e.target.checked;
      load(true);
    });

    // Row click → jump to agency detail (Creators tab there).
    main.querySelectorAll("tbody tr[data-agency-id]").forEach((tr) => {
      tr.addEventListener("click", () => {
        const id = tr.dataset.agencyId;
        if (id) R().pushAgencyDetail(id);
      });
    });
  }

  window.OnlinodAdminCreators = { render };
})();
