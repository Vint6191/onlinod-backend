/* public/admin/modules/admin-devices/admin-devices.js
   ────────────────────────────────────────────────────────────
   All worker devices across all agencies.
   
   Filters:
     q        — search by deviceName or platform
     agencyId — filter to one agency
     online   — only devices with lastSeenAt within last 5 min
     offline  — only devices NOT seen in last 5 min
   
   Per-row action: kick (queues FORCE_LOGOUT command for Electron
   to apply on next heartbeat + revokes refresh sessions).
   
   We also track which devices are stale (>24h) and surface them
   prominently — likely candidates for cleanup.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const State = () => window.OnlinodAdminState;
  const A     = () => window.OnlinodAdminApi;
  const R     = () => window.OnlinodAdminRouter;
  const U     = () => window.OnlinodAdminUtils;

  const ONLINE_WINDOW_MS = 5 * 60 * 1000;
  const STALE_WINDOW_MS  = 24 * 60 * 60 * 1000;

  function slice() { return State().devices; }

  async function load(force) {
    const s = slice();
    if (s.loading) return;
    if (!force && s.list.length && Date.now() - s.lastLoadedAt < 30_000) return;

    s.loading = true;
    s.error = null;
    rerender();

    const result = await A().listDevices({
      q:        s.filters.q || undefined,
      agencyId: s.filters.agencyId || undefined,
      online:   s.filters.online  ? "1" : undefined,
      offline:  s.filters.offline ? "1" : undefined,
    });

    s.loading = false;
    if (!result?.ok) {
      s.error = result?.error || "Failed to load devices";
      s.list = [];
    } else {
      s.list = Array.isArray(result.devices) ? result.devices : [];
      s.lastLoadedAt = Date.now();
    }
    rerender();
  }

  function rerender() {
    const main = document.getElementById("admMain");
    if (main) render(main);
  }

  function deviceLiveness(device) {
    const last = device.lastSeenAt ? new Date(device.lastSeenAt).getTime() : 0;
    if (!last) return "never";
    const age = Date.now() - last;
    if (age <= ONLINE_WINDOW_MS) return "online";
    if (age <= STALE_WINDOW_MS)  return "idle";
    return "stale";
  }

  function render(main) {
    const s = slice();
    const r = R();
    const u = U();

    if (!s.list.length && !s.loading && !s.error) load(false);

    const onlineCount = s.list.filter((d) => deviceLiveness(d) === "online").length;
    const staleCount  = s.list.filter((d) => deviceLiveness(d) === "stale").length;

    main.innerHTML = `
      <div class="adm-page-head">
        <div>
          <div class="adm-page-title">Devices</div>
          <div class="adm-page-subtitle">
            ~/admin/devices · ${r.escapeHtml(String(s.list.length))} total
            · ${r.escapeHtml(String(onlineCount))} online
            ${staleCount ? ` · ${r.escapeHtml(String(staleCount))} stale` : ""}
          </div>
        </div>
        <button class="adm-btn ghost" id="admDevicesRefresh">↻ refresh</button>
      </div>

      ${s.error ? `<div class="adm-error">${r.escapeHtml(s.error)}</div>` : ""}

      <div class="adm-table-wrap">
        <div class="adm-table-toolbar">
          <input class="adm-input" id="admDevicesQ"
                 placeholder="search by device name or platform…"
                 value="${r.escapeAttr(s.filters.q)}" style="min-width:280px;">

          <input class="adm-input mono" id="admDevicesAgency"
                 placeholder="agency id"
                 value="${r.escapeAttr(s.filters.agencyId)}" style="min-width:180px;">

          <label class="adm-toolbar-check">
            <input type="checkbox" id="admDevicesOnline" ${s.filters.online ? "checked" : ""}>
            online only
          </label>

          <label class="adm-toolbar-check">
            <input type="checkbox" id="admDevicesOffline" ${s.filters.offline ? "checked" : ""}>
            offline only
          </label>

          <div class="adm-table-toolbar-spacer"></div>

          <span style="color:var(--adm-muted);font-family:var(--adm-mono);font-size:11px;">
            ${s.loading ? "loading…" : (s.lastLoadedAt ? `loaded ${u.timeAgo(s.lastLoadedAt)}` : "")}
          </span>
        </div>

        ${
          s.loading && !s.list.length
            ? `<div class="adm-loading">loading devices…</div>`
            : !s.list.length
            ? `<div class="adm-empty">No devices match these filters.</div>`
            : `
              <table class="adm-table">
                <thead>
                  <tr>
                    <th>device</th>
                    <th>agency</th>
                    <th>platform</th>
                    <th>app version</th>
                    <th>liveness</th>
                    <th>last seen</th>
                    <th></th>
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

    bind(main);
  }

  function renderRow(d) {
    const r = R();
    const u = U();
    const live = deviceLiveness(d);

    const livenessPill = {
      online: `<span class="adm-pill ok">online</span>`,
      idle:   `<span class="adm-pill warn">idle</span>`,
      stale:  `<span class="adm-pill crit">stale</span>`,
      never:  `<span class="adm-pill muted no-dot">never seen</span>`,
    }[live];

    return `
      <tr data-device-id="${r.escapeAttr(d.id)}" data-device-name="${r.escapeAttr(d.deviceName || "device")}">
        <td>
          <div class="adm-cell-name">
            ${u.letterAvatar(d.deviceName || "D", 26)}
            <div class="adm-cell-name-main">
              <div class="adm-cell-name-strong">${r.escapeHtml(d.deviceName || "—")}</div>
              <div class="adm-cell-name-sub">${r.escapeHtml(d.id)}</div>
            </div>
          </div>
        </td>
        <td class="adm-cell-mono">${r.escapeHtml(d.agencyId.slice(-10))}</td>
        <td class="adm-cell-mono">${r.escapeHtml(d.platform || "—")}</td>
        <td class="adm-cell-mono">${r.escapeHtml(d.appVersion || "—")}</td>
        <td>${livenessPill}</td>
        <td class="adm-cell-mono">${r.escapeHtml(u.timeAgo(d.lastSeenAt))}</td>
        <td>
          <button class="adm-btn danger" data-device-kick="${r.escapeAttr(d.id)}" data-device-name="${r.escapeAttr(d.deviceName || "device")}">kick</button>
        </td>
      </tr>
    `;
  }

  function bind(main) {
    main.querySelector("#admDevicesRefresh")?.addEventListener("click", () => load(true));

    const s = slice();
    let qTimer = null;
    let aTimer = null;

    main.querySelector("#admDevicesQ")?.addEventListener("input", (e) => {
      s.filters.q = e.target.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => load(true), 250);
    });

    main.querySelector("#admDevicesAgency")?.addEventListener("input", (e) => {
      s.filters.agencyId = e.target.value;
      clearTimeout(aTimer);
      aTimer = setTimeout(() => load(true), 250);
    });

    main.querySelector("#admDevicesOnline")?.addEventListener("change", (e) => {
      s.filters.online = e.target.checked;
      if (e.target.checked) {
        // online + offline are mutually exclusive
        s.filters.offline = false;
        const off = main.querySelector("#admDevicesOffline");
        if (off) off.checked = false;
      }
      load(true);
    });

    main.querySelector("#admDevicesOffline")?.addEventListener("change", (e) => {
      s.filters.offline = e.target.checked;
      if (e.target.checked) {
        s.filters.online = false;
        const on = main.querySelector("#admDevicesOnline");
        if (on) on.checked = false;
      }
      load(true);
    });

    // Kick buttons.
    main.querySelectorAll("[data-device-kick]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const id   = btn.dataset.deviceKick;
        const name = btn.dataset.deviceName || "device";
        if (!confirm(`Kick "${name}"?\n\nElectron will get FORCE_LOGOUT command on next heartbeat.\nRefresh sessions for this user will be revoked immediately.`)) return;

        const result = await A().kickDevice(id, { reason: "admin kick from devices page" });
        R().toast(result?.ok ? "device kicked" : (result?.error || "failed"));
        if (result?.ok) load(true);
      });
    });
  }

  window.OnlinodAdminDevices = { render };
})();
