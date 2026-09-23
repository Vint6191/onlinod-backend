(function () {
  "use strict";
  const TOKEN_KEY = "onlinod_admin_token";

  function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}

  async function request(path, options = {}) {
    const token = localStorage.getItem(TOKEN_KEY) || "";
    let command;
    try {
      command = await window.OnlinodAdminCommands.prepare({ path, method: options.method || "GET", body: options.body, token });
      if (command?.blocked) {
        const resolved = await window.OnlinodAdminCommands.resolve(path, options.method || "GET", token);
        return resolved.pending ? command.result : { ok: false, error: "Previous change completed. Reload current values before editing again." };
      }
      const res = await fetch(path, {
        method: options.method || "GET",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(command ? { "Idempotency-Key": command.commandId } : {}) },
        body: options.body ? JSON.stringify(options.body) : undefined,
      });
      let data = await res.json().catch(() => ({ ok: false, code: "INVALID_JSON", error: "Response could not be read; retry the same change" }));
      if (command && res.ok && (data?.ok !== true || data.commandId !== command.commandId)) data = { ok: false, code: "ADMIN_COMMAND_RESPONSE_UNKNOWN", commandId: command.commandId, error: "Result could not be confirmed. Retry the same change." };
      window.OnlinodAdminCommands.settle(command, res, data);
      return data;
    } catch (_) { return { ok: false, code: "NETWORK", commandId: command?.commandId, error: "Result unknown. Retry the same change." }; }
  }

  function renderLogin(root, error="") {
    root.innerHTML = `<main class="admin-login-shell"><section class="admin-login-card">
      <div class="admin-login-brand"><strong>Onlinod Admin</strong><span>internal access only</span></div>
      ${error ? `<div class="admin-error">${esc(error)}</div>` : ""}
      <label class="on-field"><span>Admin email</span><input class="on-input" id="adminLoginEmail" autocomplete="username"></label>
      <label class="on-field"><span>Password</span><input class="on-input" id="adminLoginPassword" autocomplete="current-password" type="password"></label>
      <button class="on-btn primary" id="adminLoginSubmit">Login</button>
    </section></main>`;

    const submit = root.querySelector("#adminLoginSubmit");
    const email = root.querySelector("#adminLoginEmail");
    const password = root.querySelector("#adminLoginPassword");
    async function login() {
      submit.disabled = true;
      const result = await request("/api/admin-auth/login", { method:"POST", body:{ email: email.value, password: password.value } });
      if (!result.ok) return renderLogin(root, result.error || "Admin login failed");
      localStorage.setItem(TOKEN_KEY, result.token);
      localStorage.setItem("onlinod_admin", JSON.stringify(result.admin || {}));
      history.pushState({}, "", "/admin");
      window.OnlinodRouter.render();
    }
    submit.addEventListener("click", login);
    password.addEventListener("keydown", e => { if (e.key === "Enter") login(); });
  }

  async function ensureAdminSession(root) {
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { renderLogin(root); return false; }
    const me = await request("/api/admin-auth/me");
    if (!me.ok) { localStorage.removeItem(TOKEN_KEY); renderLogin(root, me.error || "Admin session expired"); return false; }
    return true;
  }

  async function logout() {
    await request("/api/admin-auth/logout", { method:"POST" });
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem("onlinod_admin");
    history.pushState({}, "", "/admin-login");
    window.OnlinodRouter.render();
  }

  window.OnlinodAdminAuth = { TOKEN_KEY, request, renderLogin, ensureAdminSession, logout };
})();
