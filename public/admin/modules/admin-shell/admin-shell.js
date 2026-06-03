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
    { key: "data",      label: "Data",      icon: "⛁" },
    { key: "billing",   label: "Billing",   icon: "$" },
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
          <input id="admGlobalSearch" type="text" placeholder="search fan / @username / messageId / creator / agency…" autocomplete="off" />
          <div class="adm-search-results" id="admSearchResults"></div>
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
    if (active === "creator-detail" || active === "creators-detail") active = "creators";
    if (active === "billing-detail") active = "billing";

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

    // Global search
    bindGlobalSearch(root);

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

  let searchTimer = null;
  function bindGlobalSearch(root) {
    const input = root.querySelector("#admGlobalSearch");
    const box   = root.querySelector("#admSearchResults");
    if (!input || !box) return;
    const A = () => window.OnlinodAdminApi;
    const close = () => { box.classList.remove("active"); box.innerHTML = ""; };
    input.addEventListener("input", () => {
      const q = input.value.trim();
      clearTimeout(searchTimer);
      if (q.length < 2) { close(); return; }
      searchTimer = setTimeout(async () => {
        const r = await A().dataSearch(q);
        if (!r || !r.ok) { close(); return; }
        renderSearchResults(box, r.results || {});
      }, 250);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") { input.value = ""; close(); } });
    document.addEventListener("click", (e) => { if (!box.contains(e.target) && e.target !== input) close(); });
  }

  function renderSearchResults(box, results) {
    const R = () => window.OnlinodAdminRouter;
    const esc = R().escapeHtml;
    const groups = [];
    const grp = (title, rows, mapFn) => {
      if (!rows || !rows.length) return;
      groups.push(`<div class="adm-search-group"><div class="adm-search-group-title">${esc(title)}</div>${rows.map(mapFn).join("")}</div>`);
    };
    grp("Agencies", results.agencies, (a) =>
      `<div class="adm-search-row" data-go="agency" data-id="${esc(a.id)}"><b>${esc(a.name)}</b><span>${esc(a.plan || "")} · ${esc(a.status || "")}</span></div>`);
    grp("Creators", results.creators, (c) =>
      `<div class="adm-search-row" data-go="creator" data-id="${esc(c.id)}"><b>${esc(c.displayName || c.username || c.id)}</b><span>@${esc(c.username || "")} · ${esc(c.status || "")}</span></div>`);
    grp("Users", results.users, (u) =>
      `<div class="adm-search-row" data-go="user" data-id="${esc(u.id)}"><b>${esc(u.email)}</b><span>${esc(u.name || "")}</span></div>`);
    grp("Fan profiles (CRM)", results.crmProfiles, (p) =>
      `<div class="adm-search-row" data-go="creator" data-id="${esc(p.creatorId)}"><b>${esc(p.name || p.username || ("fan " + p.fanId))}</b><span>fan ${esc(p.fanId)} · creator ${esc(String(p.creatorId).slice(0,8))}…</span></div>`);
    grp("Hidden online", results.hiddenOnline, (h) =>
      `<div class="adm-search-row" data-go="creator" data-id="${esc(h.creatorId)}"><b>${esc(h.username || ("fan " + h.fanId))}</b><span>${esc(h.status || "")} · fan ${esc(h.fanId)}</span></div>`);
    grp("Deliveries (by msg/fan)", results.deliveries, (d) =>
      `<div class="adm-search-row" data-go="creator" data-id="${esc(d.creatorId)}"><b>fan ${esc(d.fanId)}</b><span>${esc(d.status || "")} · msg ${esc(d.messageId || "—")}</span></div>`);
    box.innerHTML = groups.length ? groups.join("") : `<div class="adm-search-empty">nothing found</div>`;
    box.classList.add("active");
    box.querySelectorAll(".adm-search-row").forEach((el) => {
      el.addEventListener("click", () => {
        const go = el.dataset.go, id = el.dataset.id;
        box.classList.remove("active");
        const input = document.querySelector("#admGlobalSearch"); if (input) input.value = "";
        if (go === "agency") R().pushAgencyDetail(id);
        else if (go === "creator") R().pushDetail("creators", id);
        else if (go === "user") R().pushSection("users");
      });
    });
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
    if (section === "data") {
      window.OnlinodAdminData.render(main);
      return;
    }
    if (section === "billing" || section === "billing-detail") {
      window.OnlinodAdminBilling.render(main);
      return;
    }
    if (section === "creator-detail" || section === "creators-detail") {
      window.OnlinodAdminCreatorDetail.render(main);
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
