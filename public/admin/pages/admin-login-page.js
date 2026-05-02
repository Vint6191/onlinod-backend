/* public/admin/pages/admin-login-page.js */

(function () {
  "use strict";

  const A = () => window.OnlinodAdminApi;
  const R = () => window.OnlinodAdminRouter;
  const Sess = () => window.OnlinodAdminSession;

  function render(root, error) {
    root.innerHTML = `
      <main class="adm-login">
        <section class="adm-login-card">
          <div class="adm-login-brand">
            <div class="adm-login-brand-mark">O</div>
            <div class="adm-login-brand-text">
              <strong>Onlinod Admin</strong>
              <span>internal access only</span>
            </div>
          </div>

          ${error ? `<div class="adm-error">${R().escapeHtml(error)}</div>` : ""}

          <div class="adm-field">
            <label>Admin email</label>
            <input class="adm-input" id="admEmail" autocomplete="username" type="email">
          </div>

          <div class="adm-field">
            <label>Password</label>
            <input class="adm-input" id="admPassword" autocomplete="current-password" type="password">
          </div>

          <button class="adm-btn primary" id="admSubmit" style="width:100%;justify-content:center;height:36px;">
            Sign in
          </button>
        </section>
      </main>
    `;

    bind(root);
  }

  function bind(root) {
    const submit   = root.querySelector("#admSubmit");
    const email    = root.querySelector("#admEmail");
    const password = root.querySelector("#admPassword");

    async function doLogin() {
      const e = email.value.trim();
      const p = password.value;
      if (!e || !p) {
        render(root, "Email and password are required");
        return;
      }

      submit.disabled = true;
      const result = await A().login({ email: e, password: p });

      if (!result?.ok) {
        render(root, result?.error || "Admin login failed");
        return;
      }

      A().setToken(result.token);
      Sess().setAdmin(result.admin || null);

      history.pushState({}, "", "/admin");
      R().render();
    }

    submit.addEventListener("click", doLogin);
    password.addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
    email.addEventListener("keydown",    (e) => { if (e.key === "Enter") password.focus(); });

    setTimeout(() => email.focus(), 30);
  }

  window.OnlinodAdminLoginPage = { render };
})();
