/* public/admin/modules/admin-system/admin-system.js
   ────────────────────────────────────────────────────────────
   System status panel.
   
   Backend GET /api/admin/system/health returns:
     { ok, server: {version, node, uptime, memoryMb},
            db: {ok, latencyMs, error?},
            env: {hasResendKey, hasSnapshotKey, hasJwtSecret,
                  publicBaseUrl, nodeEnv} }
   
   We render it as a grid of pills + a refresh button. Auto-polls
   every 15s while the page is visible.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;
  const U = () => window.OnlinodAdminUtils;

  const state = {
    loading: false,
    error: null,
    data: null,
    lastLoadedAt: 0,
    pollTimer: null,
  };

  async function load(force) {
    if (state.loading) return;
    if (!force && state.data && Date.now() - state.lastLoadedAt < 5_000) return;

    state.loading = true;
    state.error = null;
    rerender();

    const result = await A().systemHealth();
    state.loading = false;

    if (!result?.ok && !result?.db) {
      state.error = result?.error || "Failed to load system health";
      state.data = null;
    } else {
      // Backend may return ok:false when db is down — keep the data anyway.
      state.data = result;
      state.lastLoadedAt = Date.now();
      state.error = null;
    }
    rerender();
  }

  function rerender() {
    const main = document.getElementById("admMain");
    if (main && State_section() === "system") render(main);
  }

  function State_section() {
    return window.OnlinodAdminState?.section;
  }

  function startPolling() {
    if (state.pollTimer) return;
    state.pollTimer = setInterval(() => {
      if (State_section() === "system") {
        load(true);
      } else {
        stopPolling();
      }
    }, 15_000);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function render(main) {
    const r = R();
    const u = U();

    if (!state.data && !state.loading && !state.error) {
      load(false);
    }
    startPolling();

    main.innerHTML = `
      <div class="adm-page-head">
        <div>
          <div class="adm-page-title">System</div>
          <div class="adm-page-subtitle">~/admin/system · auto-refresh 15s</div>
        </div>
        <button class="adm-btn ghost" id="admSysRefresh">↻ refresh</button>
      </div>

      ${state.error ? `<div class="adm-error">${r.escapeHtml(state.error)}</div>` : ""}

      ${
        state.loading && !state.data
          ? `<div class="adm-loading">loading system status…</div>`
          : state.data
          ? renderContent(state.data)
          : ""
      }
    `;

    main.querySelector("#admSysRefresh")?.addEventListener("click", () => load(true));
  }

  function renderContent(d) {
    const r = R();
    const u = U();
    const env = d.env || {};
    const db = d.db || {};
    const srv = d.server || {};

    const dbPill = db.ok
      ? `<span class="adm-pill ok no-dot">connected</span>`
      : `<span class="adm-pill crit no-dot">down</span>`;

    const envPill = (ok, label) => ok
      ? `<span class="adm-pill ok no-dot">${r.escapeHtml(label)}</span>`
      : `<span class="adm-pill crit no-dot">missing</span>`;

    const formatUptime = (seconds) => {
      const s = Number(seconds || 0);
      const d = Math.floor(s / 86400);
      const h = Math.floor((s % 86400) / 3600);
      const m = Math.floor((s % 3600) / 60);
      if (d) return `${d}d ${h}h ${m}m`;
      if (h) return `${h}h ${m}m`;
      return `${m}m ${s % 60}s`;
    };

    return `
      <section class="adm-metric-grid">
        ${metricCard("database",  db.ok ? `${db.latencyMs} ms` : "down", dbPill)}
        ${metricCard("uptime",    formatUptime(srv.uptime),               `<span class="adm-pill info no-dot">node ${r.escapeHtml(srv.node || "?")}</span>`)}
        ${metricCard("memory",    `${srv.memoryMb} MB`,                   `<span class="adm-pill muted no-dot">rss</span>`)}
        ${metricCard("version",   srv.version || "?",                     `<span class="adm-pill ${env.nodeEnv === "production" ? "ok" : "warn"} no-dot">${r.escapeHtml(env.nodeEnv || "?")}</span>`)}
      </section>

      <div class="adm-card" style="margin-top:6px;">
        <div class="adm-card-head">
          <div class="adm-card-title">Environment</div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px 24px;">
          ${envRow("RESEND_API_KEY",            envPill(env.hasResendKey,   "set"),   "outbound email — without this verification mails come back as devVerificationCode only")}
          ${envRow("SNAPSHOT_ENCRYPTION_KEY",   envPill(env.hasSnapshotKey, "set"),   "encrypts AccessSnapshot payload (AES-256-GCM). REQUIRED in prod.")}
          ${envRow("JWT_SECRET",                envPill(env.hasJwtSecret,   "set"),   "signs access tokens. Default 'change-me' is detected as missing.")}
          ${envRow("PUBLIC_BASE_URL",           env.publicBaseUrl ? `<span class="adm-pill ok no-dot">${r.escapeHtml(env.publicBaseUrl)}</span>` : `<span class="adm-pill warn no-dot">not set</span>`, "used to build email/impersonate URLs")}
          ${envRow("NODE_ENV",                  `<span class="adm-pill ${env.nodeEnv === "production" ? "ok" : "warn"} no-dot">${r.escapeHtml(env.nodeEnv || "?")}</span>`, "")}
        </div>
      </div>

      <div class="adm-card" style="margin-top:12px;">
        <div class="adm-card-head">
          <div class="adm-card-title">Database</div>
        </div>

        ${
          db.ok
            ? `<div style="font-family:var(--adm-mono);font-size:12px;color:var(--adm-text-soft);">
                Latency: ${r.escapeHtml(String(db.latencyMs))} ms (SELECT 1)
              </div>`
            : `<div class="adm-error">DB error: ${r.escapeHtml(db.error || "unknown")}</div>`
        }
      </div>

      <div style="margin-top:14px;color:var(--adm-muted);font-family:var(--adm-mono);font-size:11px;">
        Last polled: ${r.escapeHtml(u.timeAgo(state.lastLoadedAt))}
      </div>
    `;
  }

  function metricCard(label, value, sub) {
    const r = R();
    return `
      <div class="adm-metric">
        <div class="adm-metric-label">${r.escapeHtml(label)}</div>
        <div class="adm-metric-value">${r.escapeHtml(value)}</div>
        <div class="adm-metric-hint">${sub}</div>
      </div>
    `;
  }

  function envRow(name, valueHtml, hint) {
    const r = R();
    return `
      <div style="
        display:flex;flex-direction:column;gap:4px;
        padding:10px 12px;border-radius:8px;
        background:rgba(0,0,0,0.18);border:1px solid var(--adm-line);
      ">
        <div style="
          display:flex;align-items:center;justify-content:space-between;gap:10px;
        ">
          <span style="font-family:var(--adm-mono);font-size:11.5px;color:var(--adm-text);">
            ${r.escapeHtml(name)}
          </span>
          ${valueHtml}
        </div>
        ${hint ? `<div style="font-size:11px;color:var(--adm-muted);">${r.escapeHtml(hint)}</div>` : ""}
      </div>
    `;
  }

  window.OnlinodAdminSystem = { render };
})();
