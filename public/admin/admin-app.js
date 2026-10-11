/* public/admin/admin-app.js
   Bootstrap. Runs on every page load.
   ──────────────────────────────────────────────────────────── */

(async function () {
  "use strict";

  const A = window.OnlinodAdminApi;
  const Sess = window.OnlinodAdminSession;
  const R = window.OnlinodAdminRouter;

  let generation = 0;
  async function revalidate() {
    const own = ++generation, token = A.getToken();
    window.OnlinodAdminState.authError = null;
    R.render();
    if (token && !window.OnlinodAdminState.admin) {
      const me = await A.me();
      if (own !== generation || token !== A.getToken()) return;
      if (me?.ok && me.admin) Sess.setAdmin(me.admin);
      else if (me?.httpStatus === 403 && me.code === "ADMIN_DISABLED") Sess.clearSession();
      else window.OnlinodAdminState.authError = me?.error || "Could not verify admin access. Retry.";
    }
    R.render();
  }
  Sess.revalidate = revalidate;
  const changed = () => { generation++; Promise.resolve().then(revalidate); };
  window.addEventListener("onlinod:admin-session-changed", changed);
  window.addEventListener("storage", event => { if (event.key === "onlinod_admin_token" || event.key === null) changed(); });
  await revalidate();
})();
