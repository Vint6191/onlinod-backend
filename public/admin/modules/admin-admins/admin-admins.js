/* public/admin/modules/admin-admins/admin-admins.js
   ────────────────────────────────────────────────────────────
   Manage Onlinod admin users (us — not customer users).
   
   Backend enforces SUPER_ADMIN on create/update/reset endpoints,
   so SUPPORT-role admins see the buttons but get a 403 toast if
   they try.
   
   We intentionally show the create modal inline rather than as
   a separate page — admin user creation is rare and feels right
   as a popover.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;
  const U = () => window.OnlinodAdminUtils;
  const State = () => window.OnlinodAdminState;

  const state = {
    loading: false,
    error: null,
    list: [],
    lastLoadedAt: 0,
  };

  async function load(force) {
    if (state.loading) return;
    if (!force && state.list.length && Date.now() - state.lastLoadedAt < 30_000) return;

    state.loading = true;
    state.error = null;
    rerender();

    const result = await A().listAdminUsers();
    state.loading = false;
    if (!result?.ok) {
      state.error = result?.error || "Failed to load admins";
      state.list = [];
    } else {
      state.list = Array.isArray(result.admins) ? result.admins : [];
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
    const me = State().admin || {};

    if (!state.list.length && !state.loading && !state.error) load(false);

    main.innerHTML = `
      <div class="adm-page-head">
        <div>
          <div class="adm-page-title">Admins</div>
          <div class="adm-page-subtitle">~/admin/admins · ${r.escapeHtml(String(state.list.length))} total</div>
        </div>
        <div style="display:flex;gap:8px;">
          <button class="adm-btn primary" id="admAdminsCreate">+ create admin</button>
          <button class="adm-btn ghost" id="admAdminsRefresh">↻</button>
        </div>
      </div>

      ${state.error ? `<div class="adm-error">${r.escapeHtml(state.error)}</div>` : ""}

      <div class="adm-table-wrap">
        ${
          state.loading && !state.list.length
            ? `<div class="adm-loading">loading admins…</div>`
            : !state.list.length
            ? `<div class="adm-empty">No admin users yet.</div>`
            : `
              <table class="adm-table">
                <thead>
                  <tr>
                    <th>email</th>
                    <th>name</th>
                    <th>role</th>
                    <th>status</th>
                    <th>last login</th>
                    <th>created</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  ${state.list.map((adm) => renderRow(adm, me)).join("")}
                </tbody>
              </table>
            `
        }
      </div>

      <div id="admAdminsModal"></div>
    `;

    bind(main);
  }

  function renderRow(adm, me) {
    const r = R();
    const u = U();
    const isMe = adm.id === me.id;

    return `
      <tr>
        <td>
          <div class="adm-cell-name">
            ${u.letterAvatar(adm.email, 26)}
            <div class="adm-cell-name-main">
              <div class="adm-cell-name-strong">
                ${r.escapeHtml(adm.email)}
                ${isMe ? `<span class="adm-pill warn no-dot" style="margin-left:6px;">you</span>` : ""}
              </div>
              <div class="adm-cell-name-sub">${r.escapeHtml(adm.id)}</div>
            </div>
          </div>
        </td>
        <td class="adm-cell-mono">${r.escapeHtml(adm.name || "—")}</td>
        <td>
          <select class="adm-select" data-admin-role="${r.escapeAttr(adm.id)}" style="width:160px;" ${isMe ? "disabled" : ""}>
            <option value="SUPER_ADMIN" ${adm.role === "SUPER_ADMIN" ? "selected" : ""}>SUPER_ADMIN</option>
            <option value="SUPPORT"     ${adm.role === "SUPPORT"     ? "selected" : ""}>SUPPORT</option>
          </select>
        </td>
        <td>
          ${
            adm.active
              ? `<span class="adm-pill ok no-dot">active</span>`
              : `<span class="adm-pill crit no-dot">disabled</span>`
          }
        </td>
        <td class="adm-cell-mono">${r.escapeHtml(u.timeAgo(adm.lastLoginAt))}</td>
        <td class="adm-cell-mono">${r.escapeHtml(u.formatDate(adm.createdAt))}</td>
        <td style="white-space:nowrap;">
          ${
            isMe
              ? `<span style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);">— self —</span>`
              : `
                ${
                  adm.active
                    ? `<button class="adm-btn danger" data-admin-toggle="${r.escapeAttr(adm.id)}" data-admin-active="1">disable</button>`
                    : `<button class="adm-btn primary" data-admin-toggle="${r.escapeAttr(adm.id)}" data-admin-active="0">enable</button>`
                }
                <button class="adm-btn" data-admin-pwd="${r.escapeAttr(adm.id)}" data-admin-email="${r.escapeAttr(adm.email)}">reset pwd</button>
              `
          }
        </td>
      </tr>
    `;
  }

  function bind(main) {
    main.querySelector("#admAdminsRefresh")?.addEventListener("click", () => load(true));
    main.querySelector("#admAdminsCreate")?.addEventListener("click", () => openCreateModal());

    // Role change
    main.querySelectorAll("[data-admin-role]").forEach((sel) => {
      const original = sel.value;
      sel.addEventListener("change", async () => {
        const id = sel.dataset.adminRole;
        const newRole = sel.value;
        const result = await A().patchAdminUser(id, { role: newRole, reason: "admin role change" });
        if (!result?.ok) {
          R().toast(result?.error || "Role change failed");
          sel.value = original;
          return;
        }
        R().toast(`role → ${newRole.toLowerCase()}`);
        load(true);
      });
    });

    // Disable / enable
    main.querySelectorAll("[data-admin-toggle]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.adminToggle;
        const wasActive = btn.dataset.adminActive === "1";
        if (wasActive && !confirm("Disable this admin?\n\nAll their sessions will be revoked.")) return;
        const result = await A().patchAdminUser(id, { active: !wasActive, reason: wasActive ? "admin disable" : "admin enable" });
        R().toast(result?.ok ? (wasActive ? "admin disabled" : "admin enabled") : (result?.error || "failed"));
        if (result?.ok) load(true);
      });
    });

    // Reset password
    main.querySelectorAll("[data-admin-pwd]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.adminPwd;
        const email = btn.dataset.adminEmail;
        openPasswordResetModal(id, email);
      });
    });
  }

  // ── Create admin modal ──────────────────────────────────────

  function openCreateModal() {
    const r = R();
    const slot = document.getElementById("admAdminsModal");
    if (!slot) return;

    slot.innerHTML = `
      <div class="adm-drawer-backdrop" data-modal-close></div>
      <aside class="adm-drawer">
        <div class="adm-drawer-head">
          <div class="adm-drawer-title">Create admin</div>
          <button class="adm-btn ghost" data-modal-close>×</button>
        </div>
        <div class="adm-drawer-body">
          <div class="adm-field">
            <label>email</label>
            <input class="adm-input" id="admNewAdminEmail" autocomplete="off" type="email">
          </div>
          <div class="adm-field">
            <label>name (optional)</label>
            <input class="adm-input" id="admNewAdminName">
          </div>
          <div class="adm-field">
            <label>password</label>
            <input class="adm-input mono" id="admNewAdminPwd" type="text" placeholder="min 8 chars">
          </div>
          <div class="adm-field">
            <label>role</label>
            <select class="adm-select" id="admNewAdminRole" style="width:100%;">
              <option value="SUPPORT">SUPPORT</option>
              <option value="SUPER_ADMIN">SUPER_ADMIN</option>
            </select>
          </div>

          <div style="display:flex;gap:8px;margin-top:14px;">
            <button class="adm-btn primary" id="admNewAdminSubmit">Create</button>
            <button class="adm-btn ghost" data-modal-close>Cancel</button>
          </div>

          <div id="admNewAdminError" style="margin-top:12px;"></div>
        </div>
      </aside>
    `;

    slot.querySelectorAll("[data-modal-close]").forEach((el) => {
      el.addEventListener("click", () => { slot.innerHTML = ""; });
    });

    slot.querySelector("#admNewAdminSubmit").addEventListener("click", async () => {
      const email = slot.querySelector("#admNewAdminEmail").value.trim();
      const name  = slot.querySelector("#admNewAdminName").value.trim();
      const pwd   = slot.querySelector("#admNewAdminPwd").value;
      const role  = slot.querySelector("#admNewAdminRole").value;
      const errBox = slot.querySelector("#admNewAdminError");

      errBox.innerHTML = "";

      if (!email || !pwd) {
        errBox.innerHTML = `<div class="adm-error">email and password are required</div>`;
        return;
      }
      if (pwd.length < 8) {
        errBox.innerHTML = `<div class="adm-error">password must be ≥8 chars</div>`;
        return;
      }

      const result = await A().createAdminUser({ email, name: name || undefined, password: pwd, role });
      if (!result?.ok) {
        errBox.innerHTML = `<div class="adm-error">${R().escapeHtml(result?.error || "create failed")}</div>`;
        return;
      }
      R().toast("admin created");
      slot.innerHTML = "";
      load(true);
    });
  }

  // ── Reset password modal ────────────────────────────────────

  function openPasswordResetModal(adminId, email) {
    const r = R();
    const slot = document.getElementById("admAdminsModal");
    if (!slot) return;

    slot.innerHTML = `
      <div class="adm-drawer-backdrop" data-modal-close></div>
      <aside class="adm-drawer">
        <div class="adm-drawer-head">
          <div class="adm-drawer-title">Reset password — ${r.escapeHtml(email)}</div>
          <button class="adm-btn ghost" data-modal-close>×</button>
        </div>
        <div class="adm-drawer-body">
          <div class="adm-field">
            <label>new password</label>
            <input class="adm-input mono" id="admPwdValue" type="text" placeholder="min 8 chars">
          </div>
          <div class="adm-field">
            <label>reason (audit)</label>
            <input class="adm-input" id="admPwdReason" placeholder="e.g. lost device">
          </div>
          <div style="display:flex;gap:8px;margin-top:14px;">
            <button class="adm-btn primary" id="admPwdSubmit">Set password</button>
            <button class="adm-btn ghost" data-modal-close>Cancel</button>
          </div>
          <div id="admPwdError" style="margin-top:12px;"></div>
        </div>
      </aside>
    `;

    slot.querySelectorAll("[data-modal-close]").forEach((el) => {
      el.addEventListener("click", () => { slot.innerHTML = ""; });
    });

    slot.querySelector("#admPwdSubmit").addEventListener("click", async () => {
      const pwd    = slot.querySelector("#admPwdValue").value;
      const reason = slot.querySelector("#admPwdReason").value.trim();
      const errBox = slot.querySelector("#admPwdError");
      errBox.innerHTML = "";

      if (!pwd || pwd.length < 8) {
        errBox.innerHTML = `<div class="adm-error">password must be ≥8 chars</div>`;
        return;
      }

      const result = await A().resetAdminPwd(adminId, { password: pwd, reason: reason || undefined });
      if (!result?.ok) {
        errBox.innerHTML = `<div class="adm-error">${R().escapeHtml(result?.error || "reset failed")}</div>`;
        return;
      }
      R().toast("password set — sessions revoked");
      slot.innerHTML = "";
      load(true);
    });
  }

  window.OnlinodAdminAdmins = { render };
})();
