(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const state = {
    accessToken: localStorage.getItem("onlinod_access_token") || "",
    refreshToken: localStorage.getItem("onlinod_refresh_token") || "",
    last: null,
  };

  function setDebug(data) {
    state.last = data;
    $("debugBox").textContent = JSON.stringify(data, null, 2);

    if (data?.devVerificationCode) {
      $("verifyCode").value = data.devVerificationCode;
    }
    if (data?.user?.email) {
      $("verifyEmail").value = data.user.email;
      $("loginEmail").value = data.user.email;
      $("forgotEmail").value = data.user.email;
    }
    if (data?.devResetToken) {
      $("resetToken").value = data.devResetToken;
    }
  }

  function setSessionUI() {
    const pill = $("sessionPill");
    if (state.accessToken) {
      pill.classList.add("live");
      pill.textContent = "access token active";
    } else {
      pill.classList.remove("live");
      pill.textContent = "not logged in";
    }
  }

  function saveTokens(data) {
    if (data?.accessToken) {
      state.accessToken = data.accessToken;
      localStorage.setItem("onlinod_access_token", state.accessToken);
    }

    if (data?.refreshToken) {
      state.refreshToken = data.refreshToken;
      localStorage.setItem("onlinod_refresh_token", state.refreshToken);
    }

    setSessionUI();
  }

  function clearTokens() {
    state.accessToken = "";
    state.refreshToken = "";
    localStorage.removeItem("onlinod_access_token");
    localStorage.removeItem("onlinod_refresh_token");
    setSessionUI();
  }

  async function api(path, options = {}) {
    const headers = {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    };

    if (options.auth !== false && state.accessToken) {
      headers.Authorization = `Bearer ${state.accessToken}`;
    }

    const res = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });

    const type = res.headers.get("content-type") || "";
    let data;
    if (type.includes("application/json")) {
      data = await res.json();
    } else {
      data = { ok: res.ok, text: await res.text() };
    }

    if (!res.ok) {
      data.httpStatus = res.status;
    }

    setDebug({ request: { path, method: options.method || "GET" }, response: data });
    return data;
  }

  function bindNav() {
    document.querySelectorAll(".nav").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll(".nav").forEach((x) => x.classList.remove("active"));
        document.querySelectorAll(".panel").forEach((x) => x.classList.remove("active"));

        btn.classList.add("active");
        const panel = $("panel-" + btn.dataset.panel);
        if (panel) panel.classList.add("active");
      });
    });
  }

  async function checkHealth() {
    try {
      const res = await fetch("/health");
      const data = await res.json();
      $("apiDot").className = "dot good";
      $("apiStatus").textContent = data.status || "healthy";
      $("apiUrl").textContent = location.origin;
    } catch (err) {
      $("apiDot").className = "dot bad";
      $("apiStatus").textContent = "offline";
      $("apiUrl").textContent = String(err?.message || err);
    }
  }

  function renderCreators(list) {
    const table = $("creatorsTable");
    const creators = Array.isArray(list) ? list : [];

    $("creatorCount").textContent = `${creators.length} records`;

    if (!creators.length) {
      table.innerHTML = `<div class="note">No creator accounts yet.</div>`;
      return;
    }

    table.innerHTML = creators.map((c) => `
      <div class="row">
        <div>
          <strong>${escapeHtml(c.displayName || "Creator")}</strong>
          <small>
            ${escapeHtml(c.username ? "@" + c.username : "no username")}
            · ${escapeHtml(c.partition || "no partition")}
            · ${escapeHtml(c.id)}
          </small>
        </div>
        <div class="badge">${escapeHtml(c.status || "DRAFT")}</div>
      </div>
    `).join("");
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  function bindActions() {
    $("btnHealth").addEventListener("click", async () => {
      const data = await api("/health", { auth: false });
      setDebug(data);
    });

    $("btnRegister").addEventListener("click", async () => {
      const body = {
        email: $("regEmail").value.trim(),
        password: $("regPassword").value,
        name: $("regName").value.trim(),
        agencyName: $("regAgency").value.trim(),
      };

      const data = await api("/api/auth/register", {
        method: "POST",
        auth: false,
        body,
      });

      if (data?.devVerificationCode) {
        $("verifyEmail").value = body.email;
        $("verifyCode").value = data.devVerificationCode;
      }
    });

    $("btnVerifyCode").addEventListener("click", async () => {
      await api("/api/auth/verify-email", {
        method: "POST",
        auth: false,
        body: {
          email: $("verifyEmail").value.trim(),
          code: $("verifyCode").value.trim(),
        },
      });
    });

    $("btnResendVerify").addEventListener("click", async () => {
      const data = await api("/api/auth/resend-verification", {
        method: "POST",
        auth: false,
        body: {
          email: $("verifyEmail").value.trim(),
        },
      });

      if (data?.devVerificationCode) {
        $("verifyCode").value = data.devVerificationCode;
      }
    });

    $("btnLogin").addEventListener("click", async () => {
      const data = await api("/api/auth/login", {
        method: "POST",
        auth: false,
        body: {
          email: $("loginEmail").value.trim(),
          password: $("loginPassword").value,
        },
      });

      saveTokens(data);
      if (data?.ok) {
        await loadMe();
        await loadCreators();
      }
    });

    $("btnRefreshToken").addEventListener("click", async () => {
      const data = await api("/api/auth/refresh", {
        method: "POST",
        auth: false,
        body: {
          refreshToken: state.refreshToken,
        },
      });

      saveTokens(data);
    });

    $("btnLogout").addEventListener("click", async () => {
      if (state.refreshToken) {
        await api("/api/auth/logout", {
          method: "POST",
          auth: false,
          body: {
            refreshToken: state.refreshToken,
          },
        });
      }
      clearTokens();
    });

    $("btnForgot").addEventListener("click", async () => {
      const data = await api("/api/auth/forgot-password", {
        method: "POST",
        auth: false,
        body: {
          email: $("forgotEmail").value.trim(),
        },
      });

      if (data?.devResetToken) {
        $("resetToken").value = data.devResetToken;
      }
    });

    $("btnReset").addEventListener("click", async () => {
      await api("/api/auth/reset-password", {
        method: "POST",
        auth: false,
        body: {
          token: $("resetToken").value.trim(),
          password: $("resetPassword").value,
        },
      });
    });

    $("btnMe").addEventListener("click", loadMe);
    $("btnLoadCreators").addEventListener("click", loadCreators);

    $("btnAddCreator").addEventListener("click", async () => {
      const data = await api("/api/creators", {
        method: "POST",
        body: {
          displayName: $("creatorName").value.trim(),
          username: $("creatorUsername").value.trim(),
          status: $("creatorStatus").value,
          partition: $("creatorPartition").value.trim(),
        },
      });

      if (data?.ok) {
        $("creatorName").value = "";
        $("creatorUsername").value = "";
        $("creatorPartition").value = "";
        await loadCreators();
      }
    });

    $("btnCopyDebug").addEventListener("click", async () => {
      await navigator.clipboard.writeText($("debugBox").textContent || "{}");
    });

    $("btnClearDebug").addEventListener("click", () => setDebug({}));
  }

  async function loadMe() {
    const data = await api("/api/auth/me");
    if (data?.ok) {
      $("meUser").textContent = data.user?.email || "—";
      $("meAgency").textContent = data.agency?.name || "—";
      $("meRole").textContent = data.role || "—";
      $("meVerified").textContent = data.user?.emailVerifiedAt ? "yes" : "no";
    }
    return data;
  }

  async function loadCreators() {
    const data = await api("/api/creators");
    if (data?.ok) {
      renderCreators(data.creators || []);
    }
    return data;
  }

  function initDefaults() {
    const demoEmail = `owner_${Date.now()}@onlinod.dev`;
    $("regEmail").value = demoEmail;
    $("loginEmail").value = demoEmail;
    $("verifyEmail").value = demoEmail;
    $("forgotEmail").value = demoEmail;
    $("creatorName").value = "Mira";
    $("creatorUsername").value = "myro_slava";
    $("creatorPartition").value = "persist:acct_demo";
  }

  async function init() {
    bindNav();
    bindActions();
    initDefaults();
    setSessionUI();
    await checkHealth();

    if (state.accessToken) {
      await loadMe().catch(() => {});
      await loadCreators().catch(() => {});
    }
  }

  init();
})();
