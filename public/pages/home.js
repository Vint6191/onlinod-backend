(function () {
  "use strict";

  function helpers() {
    return {
      escapeHtml: window.OnlinodRouter.escapeHtml,
      escapeAttr: window.OnlinodRouter.escapeAttr,
      getVisibleAccounts: () => window.OnlinodState.accounts.filter((x) => x.status === "ready"),
      getProblemAccounts: () => window.OnlinodState.accounts.filter((x) => x.status !== "ready"),
      accountPublicName: (account) => account.displayName || account.username || "Account",
      accountUsernameLine: (account) => {
        const parts = [];
        if (account.username) parts.push(`@${account.username}`);
        if (account.remoteId) parts.push(`ID ${account.remoteId}`);
        return parts.join(" · ");
      },
      accountStatusLabel: (account) => String(account.status || "draft").replaceAll("_", " ").toUpperCase(),
      accountCardAvatarHtml: (account, className) => {
        const h = window.OnlinodRouter.escapeHtml;
        const a = window.OnlinodRouter.escapeAttr;
        const initial = String(account.displayName || account.username || "A").slice(0, 1).toUpperCase();

        if (account.avatarUrl || account.avatar) {
          return `<img class="${a(className)}" src="${a(account.avatarUrl || account.avatar)}" alt="">`;
        }

        return `<div class="${a(className)} fallback">${h(initial)}</div>`;
      },
      can: () => true,
      canAccessSection: () => true,
    };
  }

  function actions() {
    return {
      setAdminSection: (section) => {
        if (section === "creatorAnalytics") {
          renderRoute("creatorAnalytics");
          return;
        }
        window.OnlinodRouter.toast(`${section} is not wired yet`);
      },
      openAccountFromAdmin: (accountId) => {
        window.OnlinodRouter.toast(`Electron only: open account ${accountId}`);
      },
      addAccountFromHQ: () => {
        openAddCreatorModal();
      },
      refreshAccountMe: async (accountId) => {
        window.OnlinodRouter.toast(`Electron only: refresh users/me ${accountId}`);
        return { ok: false, code: "ELECTRON_ONLY" };
      },
      createAccessSnapshotForAccount: async (accountId) => {
        window.OnlinodRouter.toast(`Snapshots next: ${accountId}`);
      },
      revokeLatestAccessSnapshotForAccount: async (accountId) => {
        window.OnlinodRouter.toast(`Revoke snapshot next: ${accountId}`);
      },
      onTodo: (key) => {
        window.OnlinodRouter.toast(`TODO: ${key}`);
      },
    };
  }

  function mapCreatorToAccount(creator) {
    return {
      id: creator.id,
      displayName: creator.displayName,
      name: creator.displayName,
      username: creator.username,
      avatarUrl: creator.avatarUrl,
      avatar: creator.avatarUrl,
      status: String(creator.status || "DRAFT").toLowerCase(),
      remoteId: creator.remoteId,
      partition: creator.partition,
      chatMessagesCount: Number(creator.unreadCount || creator.chatMessagesCount || 0),
      subscribersCount: Number(creator.subscribersCount || 0),
      createdAt: creator.createdAt,
      updatedAt: creator.updatedAt,
    };
  }

  async function bootstrap() {
    if (!window.OnlinodState.accessToken) return;

    const me = await window.OnlinodApi.request("/api/auth/me").catch(() => null);
    if (me?.ok) {
      window.OnlinodSession.setSession(me);
    }

    await loadCreators();
  }

  async function loadCreators() {
    const creators = await window.OnlinodApi.request("/api/creators").catch(() => null);
    if (creators?.ok) {
      window.OnlinodState.accounts = (creators.creators || []).map(mapCreatorToAccount);
    }
    return creators;
  }

  function isDevToolsEnabled() {
    try {
      const params = new URLSearchParams(window.location.search || "");
      if (params.get("dev") === "1") return true;
      if (localStorage.getItem("ONLINOD_DEV_TOOLS") === "1") return true;
    } catch (_) {}

    return false;
  }

  function enableDevOnlyControls(root) {
    if (!isDevToolsEnabled()) return;

    root.querySelectorAll("[data-dev-only], #btnOpenImportCreators").forEach((el) => {
      el.style.display = "";
      el.hidden = false;
    });
  }

  function shell(inner) {
    const state = window.OnlinodState;
    const userInitial = String(state.user?.email || "AT").slice(0, 2).toUpperCase();
    const agencyName = state.agency?.name || "workspace";

    return `
      <div class="on-app-shell">
        <aside class="on-rail">
          <div class="on-rail-logo">O</div>
          <button class="on-rail-btn">HQ</button>
          <div class="on-rail-models">
            ${renderRailCreators()}
          </div>
          <div style="flex:1"></div>
          <button class="on-rail-btn" id="btnQuickAddCreator">+</button>
          <button class="on-rail-btn" id="btnLogoutApp">↩</button>
        </aside>

        <main class="on-main">
          <header class="on-topbar">
            <div class="on-wordmark">
              <span class="on-logo-mark" style="width:24px;height:24px;border-radius:8px;font-size:11px;">O</span>
              <span>onlinod</span>
            </div>

            <div class="on-workspace-pill">
              <span class="on-workspace-dot"></span>
              ${window.OnlinodRouter.escapeHtml(agencyName)}
            </div>

            <div class="on-search">⌕ jump to… <span style="margin-left:auto">⌘K</span></div>
            <button class="on-btn" id="btnToggleDebug" style="height:32px;margin:0;">debug</button>
            <div class="on-user-chip">${window.OnlinodRouter.escapeHtml(userInitial)}</div>
          </header>

          <nav class="on-nav">
            <button class="on-nav-btn active" data-route="home">Home</button>
            <button class="on-nav-btn" data-route="creatorAnalytics">Creator Analytics</button>
            <button class="on-nav-btn" data-route="team">Team Analytics</button>
            <button class="on-nav-btn" data-route="jobs">Worker Jobs</button>
            <button class="on-nav-btn" data-route="metrics">Metrics</button>
            <button class="on-nav-btn" data-route="settings">Settings</button>
          </nav>

          <section id="routeMount">${inner}</section>
        </main>

        <section class="on-debug-drawer">
          <div class="on-debug-head">
            <strong>debug.json</strong>
            <button id="btnCopyDebug">copy</button>
            <button id="btnCloseDebug">×</button>
          </div>
          <pre class="on-debug-pre">{}</pre>
        </section>

        <section class="on-modal-backdrop" id="addCreatorModal" aria-hidden="true">
          <div class="on-modal">
            <div class="on-modal-head">
              <div>
                <strong>Add or reconnect creator</strong>
                <span>Creator enrollment is owned by ONLINOD Desktop.</span>
              </div>
              <button id="btnCloseAddCreator">×</button>
            </div>
            <div class="on-connect-status active">
              <strong>Open ONLINOD Desktop</strong>
              <span>Use Creator Control in the desktop app to create a draft, verify OnlyFans identity, and publish the encrypted canonical session. The web console never receives session credentials or connection tokens.</span>
            </div>
            <div class="on-btn-row">
              <button class="on-btn primary" id="btnModalAddCreator">OK</button>
              <button class="on-btn" id="btnCancelAddCreator">Cancel</button>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  function renderRailCreators() {
    const h = window.OnlinodRouter.escapeHtml;
    const accounts = window.OnlinodState.accounts || [];
    return accounts.slice(0, 5).map((account) => {
      const initial = h(String(account.displayName || account.username || "A").slice(0, 1).toUpperCase());
      const badge = Number(account.chatMessagesCount || 0);
      return `
        <button class="on-rail-avatar" data-route="creatorAnalytics" title="${h(account.displayName || account.username || "creator")}">
          ${account.avatarUrl ? `<img src="${h(account.avatarUrl)}" alt="">` : `<span>${initial}</span>`}
          ${badge ? `<em>${h(String(badge))}</em>` : ""}
        </button>
      `;
    }).join("");
  }

  function render(root) {
    root.innerHTML = shell(`<div id="homeMount"></div>`);
    bindShell(root);
    renderRoute("home");
  }

  function renderRoute(route) {
    const mount = document.getElementById("routeMount");
    if (!mount) return;

    document.querySelectorAll(".on-nav-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.route === route);
    });

    if (route === "home") {
      mount.innerHTML = `<div id="homeMount"></div>`;
      window.OnlinodHome.render({
        root: document.getElementById("homeMount"),
        state: window.OnlinodState,
        helpers: helpers(),
        actions: actions(),
      });
      return;
    }

    if (route === "creatorAnalytics") {
      mount.innerHTML = `<div id="creatorAnalyticsMount"></div>`;
      window.OnlinodCreatorAnalytics.render({
        root: document.getElementById("creatorAnalyticsMount"),
        state: window.OnlinodState,
        helpers: helpers(),
        actions: actions(),
      });
      return;
    }

    mount.innerHTML = `
      <section class="hq-todo-section">
        <div class="hq-todo-section-main">
          <div>
            <div class="hq-page-title">${window.OnlinodRouter.escapeHtml(route)}</div>
            <div class="hq-page-subtitle">Reserved for orchestration v1. We'll wire it after Creator Analytics and Electron worker loop.</div>
          </div>
          <span class="hq-todo-badge">NEXT</span>
        </div>
      </section>
    `;
  }

  function openAddCreatorModal() {
    const modal = document.getElementById("addCreatorModal");
    if (!modal) return;
    modal.classList.add("active");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeAddCreatorModal() {
    const modal = document.getElementById("addCreatorModal");
    if (!modal) return;
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
  }

  function addCreatorFromModal() {
    closeAddCreatorModal();
    window.OnlinodRouter.toast("Open ONLINOD Desktop → Creator Control to add or reconnect creators");
  }

  function bindShell(root) {
    enableDevOnlyControls(root);

    root.querySelectorAll("[data-route]").forEach((el) => {
      el.addEventListener("click", () => renderRoute(el.dataset.route || "home"));
    });

    const logout = root.querySelector("#btnLogoutApp");
    if (logout) {
      logout.addEventListener("click", async () => {
        if (window.OnlinodState.refreshToken) {
          await window.OnlinodApi.request("/api/auth/logout", {
            method: "POST",
            auth: false,
            body: { refreshToken: window.OnlinodState.refreshToken },
          }).catch(() => {});
        }

        window.OnlinodSession.clearSession();
        window.OnlinodRouter.render();
      });
    }

    const quickAdd = root.querySelector("#btnQuickAddCreator");
    if (quickAdd) quickAdd.addEventListener("click", openAddCreatorModal);

    const close = root.querySelector("#btnCloseAddCreator");
    if (close) close.addEventListener("click", closeAddCreatorModal);

    const cancel = root.querySelector("#btnCancelAddCreator");
    if (cancel) cancel.addEventListener("click", closeAddCreatorModal);

    const modal = root.querySelector("#addCreatorModal");
    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeAddCreatorModal();
      });
    }

    const modalAdd = root.querySelector("#btnModalAddCreator");
    if (modalAdd) modalAdd.addEventListener("click", addCreatorFromModal);

    const debug = root.querySelector("#btnToggleDebug");
    if (debug) {
      debug.addEventListener("click", () => {
        document.querySelector(".on-debug-drawer")?.classList.toggle("active");
        window.OnlinodRouter.renderDebug();
      });
    }

    const closeDebug = root.querySelector("#btnCloseDebug");
    if (closeDebug) {
      closeDebug.addEventListener("click", () => {
        document.querySelector(".on-debug-drawer")?.classList.remove("active");
      });
    }

    const copyDebug = root.querySelector("#btnCopyDebug");
    if (copyDebug) {
      copyDebug.addEventListener("click", async () => {
        await navigator.clipboard.writeText(document.querySelector(".on-debug-pre")?.textContent || "{}");
        window.OnlinodRouter.toast("Copied");
      });
    }
  }

  window.OnlinodHomePage = {
    render,
    bootstrap,
    loadCreators,
    renderRoute,
    openAddCreatorModal,
  };
})();
