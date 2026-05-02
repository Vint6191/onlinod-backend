/* public/admin/modules/admin-users/admin-users.js
   ────────────────────────────────────────────────────────────
   Cross-agency users listing.
   
   Filters:
     q          — search by email or name (server-side)
     unverified — only emailVerifiedAt = null
     no_agency  — users without any AgencyMember
     disabled   — only disabled users (default: hide them)
   
   Row click → opens detail drawer (right-side panel) with:
     - basic info
     - memberships across agencies
     - recent refresh sessions
     - actions: disable/enable, force-logout, reset password
   
   We don't navigate to a separate URL for user detail — drawer is
   simpler and admins want to scan many users without losing list
   position.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const State = () => window.OnlinodAdminState;
  const A     = () => window.OnlinodAdminApi;
  const R     = () => window.OnlinodAdminRouter;
  const U     = () => window.OnlinodAdminUtils;

  function slice() { return State().users; }

  // ── List load ──────────────────────────────────────────────

  async function load(force) {
    const s = slice();
    if (s.loading) return;
    if (!force && s.list.length && Date.now() - s.lastLoadedAt < 30_000) return;

    s.loading = true;
    s.error = null;
    rerender();

    const result = await A().listUsers({
      q:          s.filters.q || undefined,
      unverified: s.filters.unverified ? "1" : undefined,
      no_agency:  s.filters.no_agency  ? "1" : undefined,
      disabled:   s.filters.disabled   ? "1" : undefined,
    });

    s.loading = false;
    if (!result?.ok) {
      s.error = result?.error || "Failed to load users";
      s.list = [];
    } else {
      s.list = Array.isArray(result.users) ? result.users : [];
      s.lastLoadedAt = Date.now();
    }
    rerender();
  }

  function rerender() {
    const main = document.getElementById("admMain");
    if (main) render(main);
  }

  // ── Render ─────────────────────────────────────────────────

  function render(main) {
    const s = slice();
    const r = R();
    const u = U();

    if (!s.list.length && !s.loading && !s.error) load(false);

    main.innerHTML = `
      <div class="adm-page-head">
        <div>
          <div class="adm-page-title">Users</div>
          <div class="adm-page-subtitle">~/admin/users · ${r.escapeHtml(String(s.list.length))} loaded</div>
        </div>
        <button class="adm-btn ghost" id="admUsersRefresh">↻ refresh</button>
      </div>

      ${s.error ? `<div class="adm-error">${r.escapeHtml(s.error)}</div>` : ""}

      <div class="adm-table-wrap">
        <div class="adm-table-toolbar">
          <input class="adm-input" id="admUsersQ" placeholder="search by email or name…"
                 value="${r.escapeAttr(s.filters.q)}" style="min-width:280px;">

          <label class="adm-toolbar-check">
            <input type="checkbox" id="admUsersUnverified" ${s.filters.unverified ? "checked" : ""}>
            unverified only
          </label>

          <label class="adm-toolbar-check">
            <input type="checkbox" id="admUsersNoAgency" ${s.filters.no_agency ? "checked" : ""}>
            no agency
          </label>

          <label class="adm-toolbar-check">
            <input type="checkbox" id="admUsersDisabled" ${s.filters.disabled ? "checked" : ""}>
            show disabled
          </label>

          <div class="adm-table-toolbar-spacer"></div>

          <span style="color:var(--adm-muted);font-family:var(--adm-mono);font-size:11px;">
            ${s.loading ? "loading…" : (s.lastLoadedAt ? `loaded ${u.timeAgo(s.lastLoadedAt)}` : "")}
          </span>
        </div>

        ${
          s.loading && !s.list.length
            ? `<div class="adm-loading">loading users…</div>`
            : !s.list.length
            ? `<div class="adm-empty">No users match these filters.</div>`
            : `
              <table class="adm-table">
                <thead>
                  <tr>
                    <th>email</th>
                    <th>name</th>
                    <th>agencies</th>
                    <th>verified</th>
                    <th>last login</th>
                    <th>created</th>
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

      <!-- Detail drawer mount point — populated lazily. -->
      <div id="admUsersDrawer"></div>
    `;

    bindToolbar(main);
    bindRows(main);
  }

  function renderRow(u_) {
    const r = R();
    const u = U();
    const isDisabled = !!u_.disabledAt;

    return `
      <tr ${isDisabled ? `class="muted"` : ""} data-user-id="${r.escapeAttr(u_.id)}">
        <td>
          <div class="adm-cell-name">
            ${u.letterAvatar(u_.email, 26)}
            <div class="adm-cell-name-main">
              <div class="adm-cell-name-strong">${r.escapeHtml(u_.email)}</div>
              <div class="adm-cell-name-sub">${r.escapeHtml(u_.id)}</div>
            </div>
          </div>
        </td>
        <td class="adm-cell-mono">${r.escapeHtml(u_.name || "—")}</td>
        <td class="adm-cell-num">${r.escapeHtml(String(u_.agenciesCount || 0))}</td>
        <td>
          ${
            u_.emailVerifiedAt
              ? `<span class="adm-pill ok no-dot">verified</span>`
              : `<span class="adm-pill warn no-dot">unverified</span>`
          }
          ${isDisabled ? `<span class="adm-pill crit no-dot" style="margin-left:6px;">disabled</span>` : ""}
        </td>
        <td class="adm-cell-mono">${r.escapeHtml(u.timeAgo(u_.lastLoginAt))}</td>
        <td class="adm-cell-mono">${r.escapeHtml(u.formatDate(u_.createdAt))}</td>
        <td>
          <button class="adm-btn ghost" data-user-open="${r.escapeAttr(u_.id)}">⮕ details</button>
        </td>
      </tr>
    `;
  }

  // ── Bind ───────────────────────────────────────────────────

  function bindToolbar(main) {
    main.querySelector("#admUsersRefresh")?.addEventListener("click", () => load(true));

    const s = slice();

    let qTimer = null;
    main.querySelector("#admUsersQ")?.addEventListener("input", (e) => {
      s.filters.q = e.target.value;
      clearTimeout(qTimer);
      qTimer = setTimeout(() => load(true), 250);
    });

    main.querySelector("#admUsersUnverified")?.addEventListener("change", (e) => {
      s.filters.unverified = e.target.checked;
      load(true);
    });

    main.querySelector("#admUsersNoAgency")?.addEventListener("change", (e) => {
      s.filters.no_agency = e.target.checked;
      load(true);
    });

    main.querySelector("#admUsersDisabled")?.addEventListener("change", (e) => {
      s.filters.disabled = e.target.checked;
      load(true);
    });
  }

  function bindRows(main) {
    main.querySelectorAll("[data-user-id]").forEach((tr) => {
      tr.addEventListener("click", () => openDrawer(tr.dataset.userId));
    });
    main.querySelectorAll("[data-user-open]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        openDrawer(btn.dataset.userOpen);
      });
    });
  }

  // ── Drawer (user detail) ───────────────────────────────────

  async function openDrawer(userId) {
    const drawer = document.getElementById("admUsersDrawer");
    if (!drawer) return;

    drawer.innerHTML = `
      <div class="adm-drawer-backdrop" data-drawer-close></div>
      <aside class="adm-drawer">
        <div class="adm-drawer-head">
          <div class="adm-drawer-title">User detail</div>
          <button class="adm-btn ghost" data-drawer-close>×</button>
        </div>
        <div class="adm-drawer-body">
          <div class="adm-loading">loading…</div>
        </div>
      </aside>
    `;
    drawer.querySelectorAll("[data-drawer-close]").forEach((el) => {
      el.addEventListener("click", () => { drawer.innerHTML = ""; });
    });

    const result = await A().getUser(userId);
    const body = drawer.querySelector(".adm-drawer-body");
    if (!body) return;

    if (!result?.ok) {
      body.innerHTML = `<div class="adm-error">${R().escapeHtml(result?.error || "Failed to load user")}</div>`;
      return;
    }

    body.innerHTML = renderDrawerBody(result);
    bindDrawerActions(body, result);
  }

  function renderDrawerBody(d) {
    const r = R();
    const u = U();
    const user = d.user;
    const memberships = d.memberships || [];
    const sessions = d.sessions || [];
    const isDisabled = !!user.disabledAt;

    return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        ${u.letterAvatar(user.email, 40)}
        <div style="min-width:0;">
          <div style="font-size:14px;font-weight:700;">${r.escapeHtml(user.email)}</div>
          <div style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);">
            ${r.escapeHtml(user.id)}
          </div>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:8px 16px;margin-bottom:18px;
                  font-family:var(--adm-mono);font-size:11.5px;">
        <div><span style="color:var(--adm-muted);">name</span><br>${r.escapeHtml(user.name || "—")}</div>
        <div><span style="color:var(--adm-muted);">created</span><br>${r.escapeHtml(u.formatDate(user.createdAt))}</div>
        <div><span style="color:var(--adm-muted);">verified</span><br>${user.emailVerifiedAt ? r.escapeHtml(u.formatDate(user.emailVerifiedAt)) : "no"}</div>
        <div><span style="color:var(--adm-muted);">last login</span><br>${r.escapeHtml(u.timeAgo(user.lastLoginAt))}</div>
        <div style="grid-column:1/-1;">
          <span style="color:var(--adm-muted);">status</span><br>
          ${
            isDisabled
              ? `<span class="adm-pill crit no-dot">disabled</span> ${user.disabledReason ? r.escapeHtml("· " + user.disabledReason) : ""}`
              : `<span class="adm-pill ok no-dot">active</span>`
          }
        </div>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">
        ${
          isDisabled
            ? `<button class="adm-btn primary" data-user-action="enable">enable</button>`
            : `<button class="adm-btn danger"  data-user-action="disable">disable</button>`
        }
        <button class="adm-btn"        data-user-action="force-logout">force logout</button>
        <button class="adm-btn"        data-user-action="reset-password">reset password</button>
      </div>

      <div class="adm-card-title" style="margin-bottom:8px;">Memberships</div>
      ${
        memberships.length
          ? `<div style="display:flex;flex-direction:column;margin-bottom:16px;">
              ${memberships.map((m) => `
                <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--adm-line);">
                  <div style="flex:1;min-width:0;">
                    <div style="font-size:12.5px;">${r.escapeHtml(m.agency.name)} ${m.agency.deletedAt ? `<span class="adm-pill crit no-dot" style="margin-left:6px;">deleted</span>` : ""}</div>
                    <div style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);">
                      ${r.escapeHtml(m.agency.id)} · ${r.escapeHtml(u.timeAgo(m.createdAt))}
                    </div>
                  </div>
                  <span class="adm-pill ${m.role === "OWNER" ? "warn" : "muted"} no-dot">${r.escapeHtml(String(m.role).toLowerCase())}</span>
                  <button class="adm-btn ghost" data-open-agency="${r.escapeAttr(m.agency.id)}">→</button>
                </div>
              `).join("")}
            </div>`
          : `<div class="adm-empty" style="padding:14px;">No memberships.</div>`
      }

      <div class="adm-card-title" style="margin-bottom:8px;">Sessions</div>
      ${
        sessions.length
          ? `<div style="display:flex;flex-direction:column;font-family:var(--adm-mono);font-size:11px;">
              ${sessions.slice(0, 10).map((s) => `
                <div style="padding:6px 0;border-top:1px solid var(--adm-line);
                            display:flex;justify-content:space-between;gap:10px;">
                  <span style="color:${s.revokedAt ? "var(--adm-muted)" : "var(--adm-text)"};">
                    ${s.revokedAt ? "revoked" : "active"} · ${r.escapeHtml(u.timeAgo(s.lastUsedAt || s.createdAt))}
                  </span>
                  <span style="color:var(--adm-muted);max-width:60%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                    ${r.escapeHtml(s.userAgent || "—")}
                  </span>
                </div>
              `).join("")}
            </div>`
          : `<div class="adm-empty" style="padding:14px;">No sessions.</div>`
      }
    `;
  }

  function bindDrawerActions(body, d) {
    body.querySelectorAll("[data-user-action]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const action = btn.dataset.userAction;
        const userId = d.user.id;

        if (action === "disable") {
          const reason = prompt("Reason for disabling? (saved to audit)") || "";
          if (reason === null) return;
          const ok = confirm(`Disable ${d.user.email}?\n\nAll their refresh sessions will be revoked.`);
          if (!ok) return;
          const result = await A().patchUser(userId, { disabled: true, disabledReason: reason, reason });
          R().toast(result?.ok ? "user disabled" : (result?.error || "failed"));
          if (result?.ok) openDrawer(userId);
          else load(true);
        }
        else if (action === "enable") {
          const result = await A().patchUser(userId, { disabled: false, reason: "admin re-enable" });
          R().toast(result?.ok ? "user enabled" : (result?.error || "failed"));
          if (result?.ok) openDrawer(userId);
        }
        else if (action === "force-logout") {
          if (!confirm(`Force logout ${d.user.email}?\n\nKills all active refresh sessions.`)) return;
          const result = await A().forceLogout(userId, { reason: "admin force-logout" });
          R().toast(result?.ok ? `${result.revokedSessions} session(s) revoked` : (result?.error || "failed"));
          if (result?.ok) openDrawer(userId);
        }
        else if (action === "reset-password") {
          if (!confirm(`Reset password for ${d.user.email}?\n\nA temporary password will be shown — copy it and share with the user.\nAll their sessions will be revoked.`)) return;
          const result = await A().resetUserPwd(userId, { reason: "admin reset" });
          if (result?.ok && result.tempPassword) {
            prompt("Temporary password (copy now — won't be shown again):", result.tempPassword);
            R().toast("password reset — sessions revoked");
            openDrawer(userId);
          } else {
            R().toast(result?.error || "failed");
          }
        }
      });
    });

    body.querySelectorAll("[data-open-agency]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const drawer = document.getElementById("admUsersDrawer");
        if (drawer) drawer.innerHTML = "";
        R().pushAgencyDetail(btn.dataset.openAgency);
      });
    });
  }

  window.OnlinodAdminUsers = { render };
})();
