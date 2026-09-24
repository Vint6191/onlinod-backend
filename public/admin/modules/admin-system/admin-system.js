/* public/admin/modules/admin-system/admin-system.js
   ────────────────────────────────────────────────────────────
   System status + retention controls.
   Retention writes are SUPER_ADMIN-only on the backend.
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

    retentionLoading: false,
    retentionSaving: false,
    retentionRunning: false,
    retentionError: null,
    retentionResult: null,
    retentionData: null,
    retentionDraft: null,
    retentionDirty: false,
    retentionReason: "",
    retentionCommand: null,
  };

  async function load(force) {
    void refreshRetentionCommand();
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
      state.data = result;
      state.lastLoadedAt = Date.now();
      state.error = null;
    }
    rerender();
  }

  let retentionGeneration = 0;
  function clearRetentionSession() {
    retentionGeneration += 1;
    Object.assign(state, { retentionLoading:false, retentionSaving:false, retentionRunning:false,
      retentionData:null, retentionDraft:null, retentionDirty:false, retentionReason:"",
      retentionResult:null, retentionError:null, retentionCommand:null, retentionPolling:false });
    rerender();
  }
  window.addEventListener("onlinod:admin-session-changed", clearRetentionSession);
  window.addEventListener("storage", event => { if (event.key === "onlinod_admin_token") clearRetentionSession(); });
  function currentRetentionRead(generation, token) { return generation === retentionGeneration && token === A().getToken(); }
  async function refreshRetentionCommand() {
    const command = state.retentionCommand;
    if (!command || !["QUEUED", "RUNNING"].includes(command.status) || state.retentionPolling) return;
    const generation = retentionGeneration, token = A().getToken();
    state.retentionPolling = true;
    try {
      const result = await A().commandStatus(command.commandId);
      if (!currentRetentionRead(generation, token)) return;
      if (result?.ok) state.retentionCommand = result;
      else state.retentionError = result?.error || "Could not read cleanup status";
    } finally { state.retentionPolling = false; rerender(); }
  }
  async function loadRetention(force) {
    if (state.retentionLoading || (!force && state.retentionData)) return;
    if (state.retentionDirty && !force) return;
    const generation = retentionGeneration, token = A().getToken();
    state.retentionLoading = true; state.retentionError = null; rerender();
    const result = await A().retentionSettings();
    if (!currentRetentionRead(generation, token)) return;
    state.retentionLoading = false;
    if (!result?.ok) state.retentionError = result?.error || "Failed to load retention settings";
    else {
      state.retentionData = result;
      state.retentionDraft = { ...(result.settings || {}) };
      state.retentionDirty = false;
      state.retentionCommand = result.lastRun || state.retentionCommand;
    }
    rerender();
  }
  async function retentionMutation(action) {
    if (state.retentionSaving || state.retentionRunning || !state.retentionData) return;
    const reason = state.retentionReason.trim();
    if (reason.length < 3) { state.retentionError = "Enter a reason (at least 3 characters)."; rerender(); return; }
    if (action === "reset" && !confirm("Save current server defaults as the retention policy?")) return;
    if (action === "run" && !confirm("Queue one cleanup pass? Eligible old data will be deleted under the displayed policy.")) return;
    const generation = retentionGeneration, token = A().getToken();
    const input = { expectedRevision:state.retentionData.revision, expectedPolicyHash:state.retentionData.policyHash, reason,
      ...(action === "set" ? {settings:{...state.retentionDraft}} : {}) };
    state.retentionSaving = action !== "run"; state.retentionRunning = action === "run";
    state.retentionError = null; state.retentionResult = null; rerender();
    const result = action === "set" ? await A().saveRetentionSettings(input)
      : action === "reset" ? await A().resetRetentionSettings(input) : await A().runRetentionSweep(input);
    if (!currentRetentionRead(generation, token)) return;
    state.retentionSaving = false; state.retentionRunning = false;
    if (!result?.ok) state.retentionError = result?.error || "Command failed; reload or retry the same change.";
    else if (action === "run") state.retentionCommand = { commandId:result.commandId, status:result.status };
    else {
      state.retentionData = result; state.retentionDraft = {...result.settings}; state.retentionDirty = false;
      state.retentionResult = { message:action === "reset" ? "Defaults saved as a new policy revision." : "Retention policy saved." };
    }
    rerender();
  }
  const saveRetention = () => retentionMutation("set");
  const resetRetention = () => retentionMutation("reset");
  const runRetentionNow = () => retentionMutation("run");

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

    if (!state.data && !state.loading && !state.error) load(false);
    if (!state.retentionData && !state.retentionLoading && !state.retentionError) loadRetention(false);
    startPolling();

    main.innerHTML = `
      <div class="adm-page-head">
        <div>
          <div class="adm-page-title">System</div>
          <div class="adm-page-subtitle">~/admin/system · health auto-refresh 15s · retention policy editable</div>
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

      ${renderRetentionCard()}
    `;

    main.querySelector("#admSysRefresh")?.addEventListener("click", () => {
      load(true);
      loadRetention(true);
    });

    bindRetentionEvents(main);
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
          ${envRow("PUBLIC_BASE_URL",           env.publicBaseUrl ? `<span class="adm-pill ok no-dot">${r.escapeHtml(env.publicBaseUrl)}</span>` : `<span class="adm-pill warn no-dot">not set</span>`, "used to build email URLs")}
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

  function renderRetentionCard() {
    const r = R();
    const data = state.retentionData || {};
    const schema = data.schema || {};
    const draft = state.retentionDraft || data.settings || {};
    const source = data.source || "?";

    const groups = [
      ["Core", ["retentionSweepWindowHours", "batchSize"]],
      ["Team activity", ["teamIntermediateDays", "teamSessionDays", "teamNoticeDays", "teamAuditDays", "teamCanonicalDetailDays", "teamMoneyRawDetailDays"]],
      ["Automation", ["automationDeliveryDetailedDays", "automationAggregateDays", "automationJobDoneDays", "automationEventDays", "automationTaskTrashDays"]],
      ["Analytics", ["analyticsIngestBatchDays", "analyticsJobInstanceDays", "analyticsDemandHistoryDays", "analyticsSupersededScanProofDays", "analyticsNonEarningsJobDays", "analyticsNonEarningsIngestBatchDays", "analyticsNotificationScanAuditDays"]],
      ["Sessions and audit", ["refreshSessionRawHistoryDays", "auditLogDays"]],
      ["Dialog intelligence", ["dialogScanChunkDays", "dialogScanRunDays"]],
      ["Traffic", ["trafficSourceMemberNoRevenueDays", "trafficZeroSnapshotDays", "trafficDailyAggregateDays", "trafficPaidOrganicLedgerDays", "trafficFreeOrganicCleanupHours"]],
    ];

    return `
      <div class="adm-card" style="margin-top:12px;">
        <div class="adm-card-head">
          <div>
            <div class="adm-card-title">Retention policy</div>
            <div style="color:var(--adm-muted);font-size:12px;margin-top:3px;">
              Retention periods for scheduled cleanup. Source: ${r.escapeHtml(source)}${data.updatedAt ? ` · updated ${r.escapeHtml(U().timeAgo(data.updatedAt))}` : ""}
            </div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;">
            <button class="adm-btn ghost" id="admRetentionReload" ${state.retentionLoading ? "disabled" : ""}>reload</button>
            <button class="adm-btn ghost" id="admRetentionReset" ${state.retentionSaving ? "disabled" : ""}>reset defaults</button>
            <button class="adm-btn ghost" id="admRetentionRun" ${state.retentionRunning || ["QUEUED","RUNNING"].includes(state.retentionCommand?.status) ? "disabled" : ""}>${state.retentionRunning ? "submitting…" : "run cleanup now"}</button>
            <button class="adm-btn" id="admRetentionSave" ${state.retentionSaving || !state.retentionDirty ? "disabled" : ""}>${state.retentionSaving ? "saving…" : "save"}</button>
          </div>
        </div>

        ${state.retentionError ? `<div class="adm-error" style="margin-bottom:10px;">${r.escapeHtml(state.retentionError)}</div>` : ""}
        ${renderRetentionResult()}
        ${state.retentionLoading && !state.retentionData ? `<div class="adm-loading">loading retention policy…</div>` : ""}

        <label>Reason for change or cleanup<input class="adm-input" id="admRetentionReason" maxlength="500" value="${r.escapeAttr(state.retentionReason)}"></label>
        ${groups.map(([title, keys]) => `
          <div style="margin-top:12px;">
            <div style="font-weight:700;margin-bottom:8px;color:var(--adm-text);">${r.escapeHtml(title)}</div>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:10px;">
              ${keys.map((key) => retentionField(key, schema[key] || {}, draft[key])).join("")}
            </div>
          </div>
        `).join("")}

        <div style="margin-top:12px;color:var(--adm-muted);font-size:12px;line-height:1.5;">
          0 is allowed only for paid organic ledger retention and means keep forever. Writes require SUPER_ADMIN.
        </div>
      </div>
    `;
  }

  function retentionField(key, spec, value) {
    const r = R();
    const safeValue = value ?? spec.fallback ?? "";
    return `
      <label style="display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:9px;background:rgba(0,0,0,.18);border:1px solid var(--adm-line);">
        <span style="display:flex;justify-content:space-between;gap:8px;align-items:center;">
          <span style="font-size:12px;font-weight:700;color:var(--adm-text);">${r.escapeHtml(spec.label || key)}</span>
          <span style="font-family:var(--adm-mono);font-size:10.5px;color:var(--adm-muted);">${r.escapeHtml(spec.unit || "")}</span>
        </span>
        <input class="adm-retention-input" data-key="${r.escapeHtml(key)}" type="number" min="${Number(spec.min ?? 0)}" max="${Number(spec.max ?? 999999)}" step="1" value="${r.escapeHtml(String(safeValue))}" style="width:100%;box-sizing:border-box;border-radius:7px;border:1px solid var(--adm-line);background:rgba(255,255,255,.04);color:var(--adm-text);padding:8px 10px;font-family:var(--adm-mono);">
        <span style="font-size:11px;color:var(--adm-muted);line-height:1.35;">${r.escapeHtml(spec.hint || "")}</span>
        <span style="font-size:10.5px;color:var(--adm-muted);font-family:var(--adm-mono);">min ${r.escapeHtml(String(spec.min ?? "?"))} · max ${r.escapeHtml(String(spec.max ?? "?"))} · default ${r.escapeHtml(String(spec.fallback ?? "?"))}</span>
      </label>
    `;
  }

  function renderRetentionResult() {
    const r = R(), command = state.retentionCommand;
    const report = command?.execution?.progress?.report;
    const status = command?.status;
    const text = status === "QUEUED" ? "Cleanup queued. This page checks progress automatically."
      : status === "RUNNING" ? "Cleanup is running."
      : status === "PARTIAL" ? "Pass finished with remaining work. Scheduled cleanup will continue."
      : status === "FAILED" ? "Cleanup pass failed or completed only partly. Review the result before retrying."
      : status === "CANCELLED" ? "Cleanup cancelled: administrator access or policy changed before execution."
      : status === "SUCCEEDED" ? "Cleanup pass completed." : "";
    return `${state.retentionResult?.message ? `<div class="adm-success">${r.escapeHtml(state.retentionResult.message)}</div>` : ""}
      ${text ? `<div class="${["FAILED","CANCELLED"].includes(status) ? "adm-error" : "adm-muted"}" style="margin:10px 0;">${r.escapeHtml(text)}
      ${report ? `<div>Rows deleted in this attempt: ${Number(report.totalDeleted || 0)}. Remaining work: ${report.remainingWork ? "yes" : "no"}.</div>` : ""}
      ${command?.execution?.progress?.code ? `<div>${r.escapeHtml(command.execution.progress.code)}</div>` : ""}
      ${report?.laneErrors?.length ? `<div>${r.escapeHtml(report.laneErrors.map(item=>`${item.lane}: ${item.error}`).join("; "))}</div>` : ""}</div>` : ""}`;
  }

  function bindRetentionEvents(main) {
    main.querySelector("#admRetentionReason")?.addEventListener("input", event => { state.retentionReason = event.target.value; });
    main.querySelector("#admRetentionReload")?.addEventListener("click", () => loadRetention(true));
    main.querySelector("#admRetentionSave")?.addEventListener("click", saveRetention);
    main.querySelector("#admRetentionReset")?.addEventListener("click", resetRetention);
    main.querySelector("#admRetentionRun")?.addEventListener("click", runRetentionNow);

    main.querySelectorAll(".adm-retention-input").forEach((input) => {
      input.addEventListener("input", () => {
        const key = input.dataset.key;
        if (!key) return;
        if (!state.retentionDraft) state.retentionDraft = { ...(state.retentionData?.settings || {}) };
        state.retentionDraft[key] = Number(input.value);
        state.retentionDirty = true;
        const save = document.getElementById("admRetentionSave");
        if (save) save.disabled = false;
      });
    });
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
