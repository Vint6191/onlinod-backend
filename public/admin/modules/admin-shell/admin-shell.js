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

  const State = () => window.NodAdminState;
  const R = () => window.NodAdminRouter;
  const Sess = () => window.NodAdminSession;
  const A = () => window.NodAdminApi;
  const W = () => window.NodAdminWorkspace;

  const SECTIONS = [
    { key: "dashboard", label: "Обзор", group: "Клиенты" },
    { key: "agencies", label: "Агентства", group: "Клиенты" },
    { key: "creators", label: "Модели", group: "Клиенты" },
    { key: "users", label: "Пользователи", group: "Клиенты" },
    { key: "billing", label: "Подписки моделей", group: "Платформа" },
    { key: "data", label: "Данные", group: "Платформа" },
    { key: "devices", label: "Устройства", group: "Платформа" },
    { key: "system", label: "Система", group: "Управление" },
    { key: "audit", label: "Журнал действий", group: "Управление" },
    { key: "admins", label: "Администраторы", group: "Управление" },
  ];
  const icon = (name) => window.NodAdminUI.icon(name);

  function render(root) {
    const state = State();
    const r = R();

    root.innerHTML = `
      <div class="adm-shell">
        ${renderTopbar(state)}
        ${renderRail(state)}

        <div class="adm-workspace"><div id="admCommandRecovery" aria-live="polite"></div>
          <main class="adm-main" id="admMain"><div class="adm-loading">loading…</div></main>
        </div>
      </div>
    `;

    bind(root);

    // Render the active page into #admMain. Done in a microtask so
    // the shell appears immediately and pages don't block paint.
    const current = W().capture(root.querySelector("#admMain"));
    Promise.resolve().then(() => {
      if (current()) {
        renderActivePage(root);
        void window.NodAdminCommandRecovery.render();
      }
    });
  }

  function renderTopbar(state) {
    const r = R();
    const admin = state.admin || {};
    const initial = (admin.name || admin.email || "A").trim().slice(0, 1).toUpperCase();

    return `
      <header class="adm-topbar">
        <div class="adm-breadcrumb">NOD <span>/</span> ${r.escapeHtml(SECTIONS.find((s) => s.key === state.section)?.label || "Карточка")}</div>
        <div class="adm-topbar-search">
          ${icon("search")}
          <input id="admGlobalSearch" type="search" aria-label="Поиск по платформе" placeholder="Найти агентство, модель, пользователя…" autocomplete="off" />
          <div class="adm-search-results" id="admSearchResults"></div>
        </div>

        <div class="adm-topbar-spacer"></div>

        <div class="adm-topbar-user">
          <div class="adm-topbar-user-avatar">${r.escapeHtml(initial)}</div>
          <div><div class="adm-topbar-user-email">${r.escapeHtml(admin.name || admin.email || "—")}</div>
          <div class="adm-topbar-user-role">${r.escapeHtml(admin.role === "SUPER_ADMIN" ? "Владелец платформы" : "Поддержка")}</div></div>
        </div>
        <button class="adm-btn ghost adm-icon-btn" id="admUserMenu" title="Выйти" aria-label="Выйти из админки">${icon("logout")}</button>
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

    let group = "";
    const items = SECTIONS.map((s) => {
      const heading = group === s.group ? "" : `<div class="adm-rail-section">${s.group}</div>`;
      group = s.group;
      return `${heading}<button type="button" class="adm-rail-item ${s.key === active ? "active" : ""}" data-section="${s.key}" title="${r.escapeAttr(s.label)}" ${s.key === active ? 'aria-current="page"' : ""}>
        <span class="adm-rail-item-icon">${icon(s.key)}</span><span>${s.label}</span></button>`;
    }).join("");
    return `<nav class="adm-rail" aria-label="Разделы админки"><div class="adm-brand"><div class="adm-brand-mark">N<i>·</i></div><div class="adm-brand-copy"><strong>NOD</strong><small>Nudes · Operation · Dollars</small></div></div>${items}<div class="adm-rail-footer">NOD Administration<br>Управление платформой</div></nav>`;
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
      let signingOut = false;
      userMenu.addEventListener("click", async () => {
        if (signingOut) return;
        if (!confirm("Выйти из админки?")) return;
        signingOut = true;
        const token = A().getToken();
        try {
          await A().logout();
        } catch (_) {
          /* ignore */
        }
        if (A().getToken() && token !== A().getToken()) return;
        Sess().clearSession();
        history.pushState({}, "", "/admin-login");
        R().render();
      });
    }
  }

  function bindGlobalSearch(root) {
    const input = root.querySelector("#admGlobalSearch");
    const box = root.querySelector("#admSearchResults");
    if (!input || !box) return;
    const A = () => window.NodAdminApi;
    let generation = 0;
    const current = W().capture(input);
    const close = () => {
      generation++;
      box.classList.remove("active");
      box.innerHTML = "";
    };
    input.addEventListener("input", () => {
      const q = input.value.trim();
      const own = ++generation;
      if (q.length < 2) {
        close();
        return;
      }
      W().debounce(
        "global-search",
        async () => {
          const r = await A().dataSearch(q);
          if (!current() || own !== generation || input.value.trim() !== q) return;
          if (!r || !r.ok) {
            close();
            return;
          }
          renderSearchResults(box, r.results || {});
        },
        250
      );
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        input.value = "";
        close();
      }
    });
    root.addEventListener("click", (e) => {
      if (!box.contains(e.target) && e.target !== input) close();
    });
  }

  function renderSearchResults(box, results) {
    const R = () => window.NodAdminRouter;
    const esc = R().escapeHtml;
    const groups = [];
    const grp = (title, rows, mapFn) => {
      if (!rows || !rows.length) return;
      groups.push(
        `<div class="adm-search-group"><div class="adm-search-group-title">${esc(title)}</div>${rows.map(mapFn).join("")}</div>`
      );
    };
    grp(
      "Агентства",
      results.agencies,
      (a) =>
        `<div class="adm-search-row" data-go="agency" data-id="${esc(a.id)}"><b>${esc(a.name)}</b><span>${esc(a.plan || "")} · ${esc(a.status || "")}</span></div>`
    );
    grp(
      "Модели",
      results.creators,
      (c) =>
        `<div class="adm-search-row" data-go="creator" data-id="${esc(c.id)}"><b>${esc(c.displayName || c.username || c.id)}</b><span>@${esc(c.username || "")} · ${esc(c.status || "")}</span></div>`
    );
    grp(
      "Пользователи",
      results.users,
      (u) =>
        `<div class="adm-search-row" data-go="user" data-id="${esc(u.id)}"><b>${esc(u.email)}</b><span>${esc(u.name || "")}</span></div>`
    );
    grp(
      "Hidden Online",
      results.hiddenOnline,
      (h) =>
        `<div class="adm-search-row" data-go="creator" data-id="${esc(h.creatorId)}"><b>${esc(h.username || "fan " + h.fanId)}</b><span>${esc(h.status || "")} · fan ${esc(h.fanId)}</span></div>`
    );
    grp(
      "Deliveries (by msg/fan)",
      results.deliveries,
      (d) =>
        `<div class="adm-search-row" data-go="creator" data-id="${esc(d.creatorId)}"><b>fan ${esc(d.fanId)}</b><span>${esc(d.status || "")} · msg ${esc(d.messageId || "—")}</span></div>`
    );
    box.innerHTML = groups.length ? groups.join("") : `<div class="adm-search-empty">Ничего не найдено</div>`;
    box.classList.add("active");
    box.querySelectorAll(".adm-search-row").forEach((el) => {
      el.addEventListener("click", () => {
        const go = el.dataset.go,
          id = el.dataset.id;
        box.classList.remove("active");
        const input = document.querySelector("#admGlobalSearch");
        if (input) input.value = "";
        if (go === "agency") R().pushAgencyDetail(id);
        else if (go === "creator") R().pushDetail("creators", id);
        else if (go === "user") {
          const users = State().users;
          users.filters.q = results.users.find((user) => user.id === id)?.email || id;
          users.lastLoadedAt = 0;
          users.list = [];
          users.error = null;
          R().pushSection("users");
        }
      });
    });
  }

  function renderActivePage(root) {
    const main = root.querySelector("#admMain");
    if (!main) return;

    const section = State().section || "dashboard";

    if (section === "dashboard") {
      window.NodAdminDashboard.render(main);
      return;
    }
    if (section === "agencies") {
      window.NodAdminAgencies.render(main);
      return;
    }
    if (section === "agency-detail") {
      window.NodAdminAgencyDetail.render(main);
      return;
    }
    if (section === "users") {
      window.NodAdminUsers.render(main);
      return;
    }
    if (section === "creators") {
      window.NodAdminCreators.render(main);
      return;
    }
    if (section === "data") {
      window.NodAdminData.render(main);
      return;
    }
    if (section === "billing" || section === "billing-detail") {
      window.NodAdminBilling.render(main);
      return;
    }
    if (section === "creator-detail" || section === "creators-detail") {
      window.NodAdminCreatorDetail.render(main);
      return;
    }
    if (section === "devices") {
      window.NodAdminDevices.render(main);
      return;
    }
    if (section === "audit") {
      window.NodAdminAudit.render(main);
      return;
    }
    if (section === "admins") {
      window.NodAdminAdmins.render(main);
      return;
    }
    if (section === "system") {
      window.NodAdminSystem.render(main);
      return;
    }

    // Unknown section — fall back to dashboard.
    window.NodAdminStateApi.setSection("dashboard", null);
    window.NodAdminDashboard.render(main);
  }

  window.NodAdminShell = { render };
})();
