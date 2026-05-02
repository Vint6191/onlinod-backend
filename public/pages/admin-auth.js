(function () {
  "use strict";
  const TOKEN_KEY = "onlinod_admin_token";

  function esc(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}

  async function request(path, options = {}) {
    const token = localStorage.getItem(TOKEN_KEY) || "";
    const res = await fetch(path, {
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    return res.json().catch(() => ({ ok:false, error:"Invalid JSON response" }));
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
