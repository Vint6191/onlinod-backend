/* public/admin/modules/admin-shell/admin-shell.js
   ────────────────────────────────────────────────────────────
   The frame around every admin page. Renders:
     - topbar (brand, search placeholder, current admin)
     - rail (section list)
     - main slot — calls the active section's render()
   
   Sections are decoupled: shell doesn't import page modules,
   it just looks them up in a map. Adding a new section = add
   one entry here + one new module file.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const State = () => window.OnlinodAdminState;
  const R     = () => window.OnlinodAdminRouter;
  const Sess  = () => window.OnlinodAdminSession;
  const A     = () => window.OnlinodAdminApi;

  // section key → { label, icon, page module accessor }
  // Pages that don't exist yet show a "TODO" placeholder.
  const SECTIONS = [
    { key: "dashboard", label: "Dashboard", icon: "▣" },
    { key: "agencies",  label: "Agencies",  icon: "◫" },
    { key: "users",     label: "Users",     icon: "👤" },
    { key: "creators",  label: "Creators",  icon: "★" },
    { key: "devices",   label: "Devices",   icon: "▤" },
    { key: "audit",     label: "Audit",     icon: "≡" },
    { key: "admins",    label: "Admins",    icon: "⛨" },
    { key: "system",    label: "System",    icon: "⚙" },
  ];

  function render(root) {
    const state = State();
    const r = R();

    root.innerHTML = `
      <div class="adm-shell">
        ${renderTopbar(state)}
        ${renderRail(state)}

        <main class="adm-main" id="admMain">
          <div class="adm-loading">loading…</div>
        </main>
      </div>
    `;

    bind(root);

    // Render the active page into #admMain. Done in a microtask so
    // the shell appears immediately and pages don't block paint.
    Promise.resolve().then(() => renderActivePage(root));
  }

  function renderTopbar(state) {
    const r = R();
    const admin = state.admin || {};
    const initial = (admin.name || admin.email || "A").trim().slice(0, 1).toUpperCase();

    return `
      <header class="adm-topbar">
        <div class="adm-topbar-brand">
          <div class="adm-topbar-brand-mark">O</div>
          <span>Onlinod Admin</span>
          <span class="adm-topbar-brand-sub">v0.7.1</span>
        </div>

        <div class="adm-topbar-search">
          <span>⌕</span>
          <span>search agencies, users, creators…  (todo)</span>
        </div>

        <div class="adm-topbar-spacer"></div>

        <div class="adm-topbar-user" id="admUserMenu" data-action="logout" title="click to log out">
          <div class="adm-topbar-user-avatar">${r.escapeHtml(initial)}</div>
          <div class="adm-topbar-user-email">${r.escapeHtml(admin.email || "—")}</div>
          <div class="adm-topbar-user-role">${r.escapeHtml(String(admin.role || "admin").toLowerCase())}</div>
        </div>
      </header>
    `;
  }

  function renderRail(state) {
    const r = R();
    let active = state.section || "dashboard";
    // Detail pages highlight their parent section in the rail.
    if (active === "agency-detail") active = "agencies";

    const items = SECTIONS.map((s) => `
      <div class="adm-rail-item ${s.key === active ? "active" : ""}" data-section="${r.escapeAttr(s.key)}">
        <span class="adm-rail-item-icon">${r.escapeHtml(s.icon)}</span>
        <span>${r.escapeHtml(s.label)}</span>
        ${s.todo ? `<span class="adm-rail-item-badge">soon</span>` : ""}
      </div>
    `).join("");

    return `
      <nav class="adm-rail">
        <div class="adm-rail-section">overview</div>
        ${items}
      </nav>
    `;
  }

  function bind(root) {
    // Rail navigation
    root.querySelectorAll(".adm-rail-item").forEach((el) => {
      el.addEventListener("click", () => {
        const key = el.dataset.section;
        if (!key) return;
        R().pushSection(key);
      });
    });

    // Logout via the user pill
    const userMenu = root.querySelector("#admUserMenu");
    if (userMenu) {
      userMenu.addEventListener("click", async () => {
        if (!confirm("Log out of admin?")) return;
        try { await A().logout(); } catch (_) { /* ignore */ }
        Sess().clearSession();
        history.pushState({}, "", "/admin-login");
        R().render();
      });
    }
  }

  function renderActivePage(root) {
    const main = root.querySelector("#admMain");
    if (!main) return;

    const section = State().section || "dashboard";

    if (section === "dashboard") {
      window.OnlinodAdminDashboard.render(main);
      return;
    }
    if (section === "agencies") {
      window.OnlinodAdminAgencies.render(main);
      return;
    }
    if (section === "agency-detail") {
      window.OnlinodAdminAgencyDetail.render(main);
      return;
    }
    if (section === "users") {
      window.OnlinodAdminUsers.render(main);
      return;
    }
    if (section === "creators") {
      window.OnlinodAdminCreators.render(main);
      return;
    }
    if (section === "devices") {
      window.OnlinodAdminDevices.render(main);
      return;
    }
    if (section === "audit") {
      window.OnlinodAdminAudit.render(main);
      return;
    }
    if (section === "admins") {
      window.OnlinodAdminAdmins.render(main);
      return;
    }
    if (section === "system") {
      window.OnlinodAdminSystem.render(main);
      return;
    }

    // Unknown section — fall back to dashboard.
    window.OnlinodAdminDashboard.render(main);
  }

  window.OnlinodAdminShell = { render };
})();
