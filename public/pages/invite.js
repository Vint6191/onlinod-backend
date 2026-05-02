(function () {
  "use strict";

  const A = () => window.OnlinodApi;
  const S = () => window.OnlinodState;
  const R = () => window.OnlinodRouter;

  function getInviteToken() {
    const match = String(location.pathname || "").match(/^\/invite\/([^/?#]+)/i);
    return match ? decodeURIComponent(match[1]) : "";
  }

  async function loadPreview() {
    const token = getInviteToken();
    if (!token) return { ok: false, code: "INVITE_TOKEN_MISSING", error: "Invite token is missing" };

    const current = S().__invitePreview;
    if (current?.token === token) return current;

    const result = await A().request(`/api/invitations/preview/${encodeURIComponent(token)}`, {
      method: "GET",
      auth: false,
    });

    S().__invitePreview = { token, ...result };
    return S().__invitePreview;
  }

  function agencyName(preview) {
    return preview?.invitation?.agency?.name || "this agency";
  }

  function roleName(preview) {
    return preview?.invitation?.roleKey || "member";
  }

  function render(root) {
    const st = S();
    const token = getInviteToken();
    const preview = st.__invitePreview?.token === token ? st.__invitePreview : null;
    const email = st.__email || preview?.invitation?.email || "";

    root.innerHTML = `
      <main class="on-auth-shell">
        <div class="on-auth-wrap">
          <div class="on-auth-logo">
            <div class="on-logo-mark">O</div>
            <div>
              <strong>Onlinod</strong>
              <span>team invitation</span>
            </div>
          </div>

          <section class="on-auth-card">
            <div class="on-auth-step active">
              <h1 class="on-auth-title">Join ${R().escapeHtml(agencyName(preview))}</h1>
              <p class="on-auth-subtitle">
                ${preview?.ok
                  ? `You've been invited as <b>${R().escapeHtml(roleName(preview))}</b>.`
                  : "Loading invitation…"}
              </p>

              <div class="on-dev-box ${preview && !preview.ok ? "active" : ""}">
                ${R().escapeHtml(preview?.error || "")}
              </div>

              <div class="on-auth-tabs">
                <button class="on-auth-tab ${st.authMode === "login" ? "active" : ""}" data-invite-mode="login">Sign in</button>
                <button class="on-auth-tab ${st.authMode === "register" ? "active" : ""}" data-invite-mode="register">Create account</button>
              </div>

              <div class="on-auth-step ${st.authMode === "login" && st.authStep !== "verify" ? "active" : ""}">
                <div class="on-field"><label>Email address</label><input class="on-input" id="inviteLoginEmail" value="${R().escapeAttr(email)}"></div>
                <div class="on-field"><label>Password</label><input class="on-input" id="inviteLoginPassword" type="password"></div>
                <div class="on-btn-row"><button class="on-btn primary" id="btnInviteLogin">Sign in & join</button></div>
              </div>

              <div class="on-auth-step ${st.authMode === "register" && st.authStep !== "verify" ? "active" : ""}">
                <div class="on-field"><label>Email address</label><input class="on-input" id="inviteRegEmail" value="${R().escapeAttr(email)}"></div>
                <div class="on-field"><label>Password</label><input class="on-input" id="inviteRegPassword" type="password"></div>
                <div class="on-field"><label>Name</label><input class="on-input" id="inviteRegName" value=""></div>
                <div class="on-btn-row"><button class="on-btn primary" id="btnInviteRegister">Create account & join</button></div>
                <div class="on-auth-note">No new agency will be created from this invite.</div>
              </div>

              <div class="on-auth-step ${st.authStep === "verify" ? "active" : ""}">
                <h1 class="on-auth-title">Verify email</h1>
                <p class="on-auth-subtitle">Enter email code, then sign in from this invite link.</p>
                <div class="on-field"><label>Email address</label><input class="on-input" id="inviteVerifyEmail" value="${R().escapeAttr(st.__email || email)}"></div>
                <div class="on-field"><label>Verification code</label><input class="on-input" id="inviteVerifyCode" value="${R().escapeAttr(st.__code || "")}"></div>
                <div class="on-btn-row"><button class="on-btn primary" id="btnInviteVerify">Verify</button></div>
                <div class="on-dev-box ${st.__code ? "active" : ""}">devVerificationCode: <b>${R().escapeHtml(st.__code || "")}</b></div>
              </div>
            </div>
          </section>
        </div>
      </main>
    `;

    bind(root, preview);
  }

  async function claimInvite(token) {
    const result = await A().request("/api/invitations/claim", {
      method: "POST",
      body: { token },
    });

    if (!result?.ok && result?.code !== "ALREADY_MEMBER") {
      return result;
    }

    return { ok: true, alreadyMember: result?.code === "ALREADY_MEMBER", raw: result };
  }

  function bind(root, preview) {
    const token = getInviteToken();

    root.querySelectorAll("[data-invite-mode]").forEach((el) => {
      el.onclick = () => {
        S().authMode = el.dataset.inviteMode || "login";
        S().authStep = "form";
        render(root);
      };
    });

    const login = root.querySelector("#btnInviteLogin");
    if (login) {
      login.onclick = async () => {
        const email = root.querySelector("#inviteLoginEmail").value.trim();
        const password = root.querySelector("#inviteLoginPassword").value;

        const session = await A().request("/api/auth/login", {
          method: "POST",
          auth: false,
          body: { email, password },
        });

        if (!session?.ok) {
          if (session?.code === "EMAIL_NOT_VERIFIED") {
            S().__email = email;
            S().authStep = "verify";
            render(root);
          }
          R().toast(session?.error || "Login failed");
          return;
        }

        window.OnlinodSession.setSession(session);

        const claim = await claimInvite(token);
        if (!claim?.ok) {
          R().toast(claim?.error || "Invite claim failed");
          return;
        }

        await window.OnlinodHomePage.bootstrap();
        history.replaceState(null, "", "/");
        window.OnlinodRouter.setView("home");
      };
    }

    const register = root.querySelector("#btnInviteRegister");
    if (register) {
      register.onclick = async () => {
        const email = root.querySelector("#inviteRegEmail").value.trim();

        const result = await A().request("/api/auth/register", {
          method: "POST",
          auth: false,
          body: {
            email,
            password: root.querySelector("#inviteRegPassword").value,
            name: root.querySelector("#inviteRegName").value.trim(),
            inviteToken: token,
          },
        });

        if (!result?.ok) {
          if (result?.inviteLoginRequired) {
            S().__email = email;
            S().authMode = "login";
            S().authStep = "form";
            render(root);
          }
          R().toast(result?.error || "Registration failed");
          return;
        }

        S().__email = email;
        S().__code = result.devVerificationCode || "";
        S().authStep = "verify";
        R().toast(result.invitationClaimed ? "Account created. Verify email to finish joining." : "Account created. Verify email.");
        render(root);
      };
    }

    const verify = root.querySelector("#btnInviteVerify");
    if (verify) {
      verify.onclick = async () => {
        const email = root.querySelector("#inviteVerifyEmail").value.trim();
        const code = root.querySelector("#inviteVerifyCode").value.trim();

        const result = await A().request("/api/auth/verify-email", {
          method: "POST",
          auth: false,
          body: { email, code },
        });

        if (!result?.ok) {
          R().toast(result?.error || "Verification failed");
          return;
        }

        S().__email = email;
        S().authStep = "form";
        S().authMode = "login";
        R().toast("Email verified. Sign in to enter the agency.");
        render(root);
      };
    }
  }

  async function bootstrap(root) {
    const preview = await loadPreview();
    render(root);
    return preview;
  }

  window.OnlinodInvitePage = {
    render,
    bootstrap,
    getInviteToken,
  };
})();
