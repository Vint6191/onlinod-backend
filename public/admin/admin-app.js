/* public/admin/admin-app.js
   Bootstrap. Runs on every page load.
   ──────────────────────────────────────────────────────────── */

(async function () {
  "use strict";

  const A = window.OnlinodAdminApi;
  const Sess = window.OnlinodAdminSession;
  const R = window.OnlinodAdminRouter;

  // If we have a token, verify it against /me. This both validates
  // and refreshes the cached admin info.
  if (A.getToken()) {
    const me = await A.me();
    if (me?.ok && me.admin) {
      Sess.setAdmin(me.admin);
    } else {
      Sess.clearSession();
    }
  }

  R.render();
})();
