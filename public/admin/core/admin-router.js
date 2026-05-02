/* public/admin/core/admin-router.js
   ────────────────────────────────────────────────────────────
   Router for the admin frontend.
   
   v2 (заход 3): now supports nested routes like
   /admin/agencies/:id — sets state.section="agency-detail" and
   state.sectionParam=":id". Other sections are unchanged.
   
   Routing rules:
     /admin-login              → admin login page
     /admin                    → shell (section: dashboard)
     /admin/agencies           → shell (section: agencies)
     /admin/agencies/:id       → shell (section: agency-detail, sectionParam: id)
     /admin/users              → shell (section: users)        — TODO заход 4
     /admin/creators           → shell (section: creators)     — TODO заход 4
     /admin/devices            → shell (section: devices)      — TODO заход 4
     /admin/audit              → shell (section: audit)        — TODO заход 5
     /admin/admins             → shell (section: admins)       — TODO заход 5
     /admin/system             → shell (section: system)       — TODO заход 5
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  function root() { return document.getElementById("app"); }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&",  "&amp;")
      .replaceAll("<",  "&lt;")
      .replaceAll(">",  "&gt;")
      .replaceAll('"',  "&quot;")
      .replaceAll("'",  "&#039;");
  }

  function escapeAttr(value) { return escapeHtml(value); }

  function toast(message, kind) {
    let el = document.querySelector(".adm-toast");
    if (!el) {
      el = document.createElement("div");
      el.className = "adm-toast";
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add("active");
    el.dataset.kind = kind || "info";

    clearTimeout(el.__timer);
    el.__timer = setTimeout(() => el.classList.remove("active"), 2600);
  }

  // Navigate to a top-level section with no params.
  function pushSection(section) {
    const path = section === "dashboard" ? "/admin" : `/admin/${section}`;
    history.pushState({}, "", path);
    window.OnlinodAdminStateApi.setSection(section, null);
    render();
  }

  // Open agency detail by id.
  function pushAgencyDetail(agencyId) {
    history.pushState({}, "", `/admin/agencies/${encodeURIComponent(agencyId)}`);
    window.OnlinodAdminStateApi.setSection("agency-detail", agencyId);
    render();
  }

  // Generic open by section + optional id (for future detail pages).
  function pushDetail(section, id) {
    if (!id) return pushSection(section);
    history.pushState({}, "", `/admin/${section}/${encodeURIComponent(id)}`);
    window.OnlinodAdminStateApi.setSection(`${section}-detail`, id);
    render();
  }

  // /admin                 → ["dashboard", null]
  // /admin/agencies        → ["agencies",  null]
  // /admin/agencies/abc    → ["agency-detail", "abc"]
  // /admin/users/xyz       → ["users-detail", "xyz"]   (future)
  function parsePath() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts[0] !== "admin") return [null, null];
    if (!parts[1]) return ["dashboard", null];

    const section = parts[1];
    const param = parts[2] || null;

    if (!param) return [section, null];

    // Detail pages: synthesize "<section>-detail" key so the shell
    // can dispatch to the right module.
    if (section === "agencies") return ["agency-detail", param];
    return [`${section}-detail`, param];
  }

  function render() {
    const r = root();
    if (!r) return;

    if (location.pathname.startsWith("/admin-login")) {
      if (window.OnlinodAdminApi.getToken()) {
        history.replaceState({}, "", "/admin");
        return render();
      }
      window.OnlinodAdminLoginPage.render(r);
      return;
    }

    if (!window.OnlinodAdminApi.getToken()) {
      history.replaceState({}, "", "/admin-login");
      window.OnlinodAdminLoginPage.render(r);
      return;
    }

    const [section, param] = parsePath();
    if (section) {
      const state = window.OnlinodAdminState;
      if (state.section !== section || state.sectionParam !== param) {
        window.OnlinodAdminStateApi.setSection(section, param);
      }
    }

    window.OnlinodAdminShell.render(r);
  }

  window.addEventListener("popstate", render);

  window.OnlinodAdminRouter = {
    render,
    escapeHtml, escapeAttr,
    toast,
    pushSection,
    pushAgencyDetail,
    pushDetail,
  };
})();
