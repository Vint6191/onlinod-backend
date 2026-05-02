/* public/admin/modules/admin-dashboard/admin-dashboard.js
   ────────────────────────────────────────────────────────────
   Landing page. Single GET /api/admin/dashboard call gives us
   everything: counts, MRR, recent admin actions, recent signups.
   
   Layout:
     - Top metric grid: agencies (with active/trial/locked split),
       users (with unverified count), creators (ready/problem),
       devices (online/total), MRR estimate.
     - Two-column row:
         left  — recent admin actions feed
         right — recent signups (last 10 users)
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const State = () => window.OnlinodAdminState;
  const A     = () => window.OnlinodAdminApi;
  const R     = () => window.OnlinodAdminRouter;
  const U     = () => window.OnlinodAdminUtils;

  function ensureSlice() {
    const s = State();
    if (!s.dashboard) {
      s.dashboard = { loading: false, error: null, data: null, lastLoadedAt: 0 };
    }
    return s.dashboard;
  }

  async function load(force) {
    const slice = ensureSlice();
    if (slice.loading) return;
    if (!force && slice.data && Date.now() - slice.lastLoadedAt < 30_000) return;

    slice.loading = true;
    slice.error = null;
    rerender();

    const result = await A().dashboard();
    slice.loading = false;

    if (!result?.ok) {
      slice.error = result?.error || "Failed to load dashboard";
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
    const slice = ensureSlice();
    const r = R();
    const u = U();

    // Kick off load if we have nothing.
    if (!slice.data && !slice.loading && !slice.error) {
      load(false);
    }

    main.innerHTML = `
      <div class="adm-page-head">
        <div>
          <div class="adm-page-title">Dashboard</div>
          <div class="adm-page-subtitle">~/admin/dashboard · live snapshot</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="adm-btn ghost" id="admDashRefresh">↻ refresh</button>
        </div>
      </div>

      ${slice.error ? `<div class="adm-error">${r.escapeHtml(slice.error)}</div>` : ""}
      ${slice.loading && !slice.data ? `<div class="adm-loading">loading dashboard…</div>` : ""}

      ${slice.data ? renderContent(slice.data) : ""}
    `;

    bind(main);
  }

  function renderContent(d) {
    const r = R();
    const u = U();

    const a = d.counts.agencies;
    const us = d.counts.users;
    const c = d.counts.creators;
    const dv = d.counts.devices;
    const sn = d.counts.snapshots;

    const mrrTotalCents =
      Number(d.mrr?.coreCents || 0) +
      Number(d.mrr?.aiChatterCents || 0) +
      Number(d.mrr?.outreachCents || 0);

    return `
      <section class="adm-metric-grid">
        ${renderMetric({
          label: "agencies",
          value: u.formatNumber(a.total),
          hint:  `${a.active} active · ${a.trial} trial · ${a.locked} locked`,
          mode:  a.locked > 0 ? "warn" : "",
        })}

        ${renderMetric({
          label: "users",
          value: u.formatNumber(us.total),
          hint:  us.unverified > 0 ? `${us.unverified} unverified` : "all verified",
          mode:  us.unverified > 0 ? "warn" : "ok",
        })}

        ${renderMetric({
          label: "creators",
          value: u.formatNumber(c.total),
          hint:  `${c.ready} ready · ${c.problem} problem`,
          mode:  c.problem > 0 ? "warn" : "",
        })}

        ${renderMetric({
          label: "devices",
          value: u.formatNumber(dv.total),
          hint:  `${dv.online} online`,
          mode:  dv.online > 0 ? "ok" : "",
        })}

        ${renderMetric({
          label: "active snapshots",
          value: u.formatNumber(sn.active),
          hint:  "encrypted in DB",
          mode:  "",
        })}

        ${renderMetric({
          label: "mrr (rough)",
          value: u.formatMoneyFromCents(mrrTotalCents),
          hint:  `core ${u.formatMoneyFromCents(d.mrr?.coreCents || 0)} · addons ${u.formatMoneyFromCents((d.mrr?.aiChatterCents || 0) + (d.mrr?.outreachCents || 0))}`,
          mode:  mrrTotalCents > 0 ? "ok" : "",
        })}
      </section>

      <section style="display:grid;grid-template-columns:1.4fr 1fr;gap:12px;margin-top:6px;">
        <div class="adm-card">
          <div class="adm-card-head">
            <div class="adm-card-title">Recent admin actions</div>
            <button class="adm-card-action" data-section="audit">view audit →</button>
          </div>

          ${
            d.recentActions?.length
              ? `<div style="display:flex;flex-direction:column;">
                  ${d.recentActions.slice(0, 12).map(renderActionRow).join("")}
                </div>`
              : `<div class="adm-empty">No actions yet.</div>`
          }
        </div>

        <div class="adm-card">
          <div class="adm-card-head">
            <div class="adm-card-title">Recent signups</div>
            <button class="adm-card-action" data-section="users">all users →</button>
          </div>

          ${
            d.recentSignups?.length
              ? `<div style="display:flex;flex-direction:column;">
                  ${d.recentSignups.map(renderSignupRow).join("")}
                </div>`
              : `<div class="adm-empty">No signups yet.</div>`
          }
        </div>
      </section>
    `;
  }

  function renderMetric({ label, value, hint, mode }) {
    const r = R();
    return `
      <div class="adm-metric ${mode || ""}">
        <div class="adm-metric-label">${r.escapeHtml(label)}</div>
        <div class="adm-metric-value">${r.escapeHtml(value)}</div>
        <div class="adm-metric-hint">${r.escapeHtml(hint)}</div>
      </div>
    `;
  }

  function renderActionRow(a) {
    const r = R();
    const u = U();
    return `
      <div style="
        display:flex;align-items:center;gap:10px;
        padding:10px 0;border-top:1px solid var(--adm-line);
      ">
        <div style="
          font-family:var(--adm-mono);font-size:11px;
          color:var(--adm-muted);min-width:80px;
        ">${r.escapeHtml(u.timeAgo(a.createdAt))}</div>

        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;color:var(--adm-text);">
            ${r.escapeHtml(a.action)}
          </div>
          <div style="
            font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);
            white-space:nowrap;overflow:hidden;text-overflow:ellipsis;
          ">
            ${a.targetType ? `${r.escapeHtml(a.targetType)} ${r.escapeHtml(String(a.targetId || ""))}` : ""}
            ${a.reason ? `· ${r.escapeHtml(a.reason)}` : ""}
          </div>
        </div>

        ${a.agencyId ? `<span class="adm-pill muted no-dot">${r.escapeHtml(a.agencyId.slice(-6))}</span>` : ""}
      </div>
    `;
  }

  function renderSignupRow(u_) {
    const r = R();
    const u = U();
    const initial = String(u_.email || "?").trim().slice(0, 1).toUpperCase();

    return `
      <div style="
        display:flex;align-items:center;gap:10px;
        padding:10px 0;border-top:1px solid var(--adm-line);
      ">
        ${u.letterAvatar(u_.email, 26)}

        <div style="flex:1;min-width:0;">
          <div style="font-size:12.5px;color:var(--adm-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
            ${r.escapeHtml(u_.email)}
          </div>
          <div style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);">
            ${u_.name ? r.escapeHtml(u_.name) + " · " : ""}${r.escapeHtml(u.timeAgo(u_.createdAt))}
          </div>
        </div>

        ${
          u_.emailVerifiedAt
            ? `<span class="adm-pill ok">verified</span>`
            : `<span class="adm-pill warn">unverified</span>`
        }
      </div>
    `;
  }

  function bind(main) {
    main.querySelector("#admDashRefresh")?.addEventListener("click", () => load(true));
    main.querySelectorAll("[data-section]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.preventDefault();
        R().pushSection(el.dataset.section);
      });
    });
  }

  window.OnlinodAdminDashboard = { render };
})();
