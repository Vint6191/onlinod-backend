/* public/admin/admin-app.js
   Bootstrap. Runs on every page load.
   ──────────────────────────────────────────────────────────── */

(async function () {
  "use strict";

  const A = window.NodAdminApi;
  const Sess = window.NodAdminSession;
  const R = window.NodAdminRouter;

  let generation = 0;
  async function revalidate() {
    const own = ++generation, token = A.getToken();
    window.NodAdminState.authError = null;
    R.render();
    if (token && !window.NodAdminState.admin) {
      const me = await A.me();
      if (own !== generation || token !== A.getToken()) return;
      if (me?.ok && me.admin) Sess.setAdmin(me.admin);
      else if (me?.httpStatus === 403 && me.code === "ADMIN_DISABLED") Sess.clearSession();
      else window.NodAdminState.authError = me?.error || "Could not verify admin access. Retry.";
    }
    R.render();
  }
  Sess.revalidate = revalidate;
  const changed = () => { generation++; Promise.resolve().then(revalidate); };
  window.addEventListener("nod:admin-session-changed", changed);
  window.addEventListener("storage", event => { if (event.key === "onlinod_admin_token" || event.key === null) changed(); });
  await revalidate();
})();
