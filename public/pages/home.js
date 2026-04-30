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
            <button class="on-btn" id="btnOpenImportCreators" style="height:32px;margin:0;display:none;">dev migrate</button>
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
                <strong>Add creator account</strong>
                <span>Create backend draft record. Electron binding comes next.</span>
              </div>
              <button id="btnCloseAddCreator">×</button>
            </div>

            <div class="on-connect-status" id="connectStatusBox">
              <strong>Connection flow</strong>
              <span>Start creates a draft creator and opens Onlinod desktop app.</span>
              <pre id="connectStatusText">idle</pre>
              <div class="on-btn-row" style="margin-top:10px;">
                <button class="on-btn" id="btnCopyConnectUrl" type="button">Copy connect URL</button>
                <button class="on-btn" id="btnSimulateConnect" type="button">Dev: simulate complete</button>
              </div>
            </div>

            <div class="on-field">
              <label>Display name</label>
              <input class="on-input" id="modalCreatorDisplayName" value="Mira">
            </div>

            <div class="on-field">
              <label>Username / OF handle</label>
              <input class="on-input" id="modalCreatorUsername" value="myro_slava">
            </div>

            <div class="on-field">
              <label>Partition</label>
              <input class="on-input" id="modalCreatorPartition" value="persist:acct_demo">
            </div>

            <div class="on-field">
              <label>Status</label>
              <select class="on-select" id="modalCreatorStatus">
                <option value="draft">draft</option>
                <option value="ready">ready</option>
                <option value="not_creator">not_creator</option>
                <option value="auth_failed">auth_failed</option>
                <option value="disabled">disabled</option>
              </select>
            </div>

            <div class="on-btn-row">
              <button class="on-btn primary" id="btnModalAddCreator">Start Connect</button>
              <button class="on-btn" id="btnCancelAddCreator">Cancel</button>
            </div>
          </div>
        </section>

        <section class="on-modal-backdrop" id="importCreatorsModal" data-dev-only aria-hidden="true">
          <div class="on-modal">
            <div class="on-modal-head">
              <div>
                <strong>DEV migration: local creators + snapshots</strong>
                <span>Temporary internal tool. Electron uploads local snapshots directly.</span>
              </div>
              <button id="btnCloseImportCreators">×</button>
            </div>

            <div class="on-connect-status active">
              <strong>Automatic dev migration</strong>
              <span>No JSON. No DevTools. This opens Electron and Electron uploads local snapshots directly to backend.</span>
              <pre id="migrationStatusText">idle</pre>
            </div>

            <div class="on-btn-row">
              <button class="on-btn primary" id="btnImportCreators">Start auto migration</button>
              <button class="on-btn" id="btnCancelImportCreators">Cancel</button>
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
    const suffix = Date.now().toString(36);
    const partition = document.getElementById("modalCreatorPartition");
    if (partition && !partition.value.trim()) partition.value = `persist:acct_${suffix}`;
    modal.classList.add("active");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeAddCreatorModal() {
    const modal = document.getElementById("addCreatorModal");
    if (!modal) return;
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
  }

  function openImportCreatorsModal() {
    if (!isDevToolsEnabled()) {
      window.OnlinodRouter.toast("Dev import is disabled");
      return;
    }

    const modal = document.getElementById("importCreatorsModal");
    if (!modal) return;
    modal.classList.add("active");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeImportCreatorsModal() {
    const modal = document.getElementById("importCreatorsModal");
    if (!modal) return;
    modal.classList.remove("active");
    modal.setAttribute("aria-hidden", "true");
  }



  async function copyMigrationUrlForElectron(url) {
    const text = String(url || "").trim();
    if (!text) return false;

    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "readonly");
        area.style.position = "fixed";
        area.style.left = "-9999px";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
        return true;
      } catch (_) {
        return false;
      }
    }
  }

  async function pollAutoMigrationStatus(token) {
    const statusEl = document.getElementById("migrationStatusText");
    if (!token) return;

    const started = Date.now();
    const timeoutMs = 120000;

    while (Date.now() - started < timeoutMs) {
      let status;

      try {
        status = await window.OnlinodApi.request(
          `/api/creators/import-local/status-auto?token=${encodeURIComponent(token)}`
        );
      } catch (err) {
        status = {
          ok: false,
          error: err?.message || String(err),
        };
      }

      if (statusEl) {
        statusEl.textContent = JSON.stringify(status, null, 2);
      }

      if (status?.ok && status.status === "COMPLETED") {
        await loadCreators();
        closeImportCreatorsModal();
        render(document.getElementById("app"));
        renderRoute("creatorAnalytics");

        const r = status.result || {};
        window.OnlinodRouter.toast(
          `Migration done: creators ${r.imported || 0}, snapshots ${r.snapshotsImported || 0}`
        );
        return;
      }

      if (status?.ok && (status.status === "FAILED" || status.status === "EXPIRED")) {
        window.OnlinodRouter.toast(status.error || `Migration ${status.status.toLowerCase()}`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    if (statusEl) {
      statusEl.textContent = "Migration timeout. Electron opened, but backend did not receive completed migration.";
    }

    window.OnlinodRouter.toast("Migration timeout");
  }

  async function importCreatorsFromJson() {
    if (!isDevToolsEnabled()) {
      window.OnlinodRouter.toast("Dev import is disabled");
      return;
    }

    const status = document.getElementById("migrationStatusText");
    if (status) status.textContent = "starting migration session…";

    const start = await window.OnlinodApi.request("/api/creators/import-local/start-auto", {
      method: "POST",
      body: {},
    });

    if (!start?.ok) {
      if (status) status.textContent = JSON.stringify(start, null, 2);
      window.OnlinodRouter.toast(start?.error || "Migration start failed");
      return;
    }

    window.OnlinodState.currentLocalMigration = start;

    if (status) {
      status.textContent = JSON.stringify({
        status: "opening Electron",
        migrateUrl: start.migrateUrl,
        expiresAt: start.expiresAt,
      }, null, 2);
    }

    const copied = await copyMigrationUrlForElectron(start.migrateUrl);

    if (status) {
      status.textContent = JSON.stringify({
        status: "opening Electron",
        migrateUrl: start.migrateUrl,
        clipboardFallback: copied,
        expiresAt: start.expiresAt,
      }, null, 2);
    }

    try {
      window.location.href = start.migrateUrl;
    } catch (_) {}

    window.OnlinodRouter.toast(
      copied
        ? "Opening Electron for migration… fallback copied"
        : "Opening Electron for migration…"
    );

    pollAutoMigrationStatus(start.token).catch((err) => {
      if (status) {
        status.textContent = JSON.stringify({
          ok: false,
          error: err?.message || String(err),
        }, null, 2);
      }
    });
  }

  async function addCreatorFromModal() {
    const displayName = document.getElementById("modalCreatorDisplayName")?.value?.trim() || "Creator";
    const username = document.getElementById("modalCreatorUsername")?.value?.trim() || "";
    let partition = document.getElementById("modalCreatorPartition")?.value?.trim() || "";

    if (!partition) {
      partition = `persist:creator_pending_${Date.now().toString(36)}`;
    }

    const data = await window.OnlinodApi.request("/api/creator-connect/start", {
      method: "POST",
      body: {
        displayName,
        username,
        partition,
      },
    });

    if (!data.ok) {
      window.OnlinodRouter.toast(data.error || "Failed to start creator connect");
      setConnectStatus("failed", data);
      return;
    }

    window.OnlinodState.currentConnectSession = data;
    setConnectStatus("pending", data);

    // Try to open desktop app through custom protocol. Browser may show a
    // confirmation prompt. This is expected.
    try {
      window.location.href = data.connectUrl;
    } catch (_) {
      /* ignore */
    }

    await loadCreators();
    renderRoute("creatorAnalytics");
    window.OnlinodRouter.toast("Connect session started");
  }

  function setConnectStatus(label, data = null) {
    const box = document.getElementById("connectStatusBox");
    const text = document.getElementById("connectStatusText");
    if (!box || !text) return;

    box.classList.add("active");
    text.textContent = JSON.stringify({
      status: label,
      sessionId: data?.session?.id || data?.session?.id || data?.id || null,
      connectUrl: data?.connectUrl || null,
      token: data?.token || null,
      response: data,
    }, null, 2);
  }

  async function pollConnectStatus() {
    const current = window.OnlinodState.currentConnectSession;
    const sessionId = current?.session?.id;
    if (!sessionId) {
      window.OnlinodRouter.toast("No connect session yet");
      return null;
    }

    const data = await window.OnlinodApi.request(`/api/creator-connect/${encodeURIComponent(sessionId)}/status`);
    setConnectStatus(data?.session?.status || "status", data);

    if (data?.ok) {
      await loadCreators();
      renderRoute("creatorAnalytics");
    }

    return data;
  }

  async function simulateConnectComplete() {
    const current = window.OnlinodState.currentConnectSession;
    const sessionId = current?.session?.id;
    if (!sessionId) {
      window.OnlinodRouter.toast("Start connect session first");
      return;
    }

    const data = await window.OnlinodApi.request(`/api/creator-connect/${encodeURIComponent(sessionId)}/simulate-complete`, {
      method: "POST",
      body: {},
    });

    setConnectStatus(data?.ok ? "completed" : "failed", data);

    if (data?.ok) {
      await loadCreators();
      closeAddCreatorModal();
      render(document.getElementById("app"));
      renderRoute("creatorAnalytics");
      window.OnlinodRouter.toast("Dev snapshot saved on server");
    } else {
      window.OnlinodRouter.toast(data.error || "Simulate failed");
    }
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

    const copyConnectUrl = root.querySelector("#btnCopyConnectUrl");
    if (copyConnectUrl) {
      copyConnectUrl.addEventListener("click", async () => {
        const url = window.OnlinodState.currentConnectSession?.connectUrl || "";
        if (!url) {
          window.OnlinodRouter.toast("No connect URL yet");
          return;
        }
        await navigator.clipboard.writeText(url);
        window.OnlinodRouter.toast("Connect URL copied");
      });
    }

    const simulateConnect = root.querySelector("#btnSimulateConnect");
    if (simulateConnect) simulateConnect.addEventListener("click", simulateConnectComplete);

    const openImport = root.querySelector("#btnOpenImportCreators");
    if (openImport) openImport.addEventListener("click", openImportCreatorsModal);

    const closeImport = root.querySelector("#btnCloseImportCreators");
    if (closeImport) closeImport.addEventListener("click", closeImportCreatorsModal);

    const cancelImport = root.querySelector("#btnCancelImportCreators");
    if (cancelImport) cancelImport.addEventListener("click", closeImportCreatorsModal);

    const importModal = root.querySelector("#importCreatorsModal");
    if (importModal) {
      importModal.addEventListener("click", (event) => {
        if (event.target === importModal) closeImportCreatorsModal();
      });
    }

    const importCreators = root.querySelector("#btnImportCreators");
    if (importCreators) importCreators.addEventListener("click", importCreatorsFromJson);

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
