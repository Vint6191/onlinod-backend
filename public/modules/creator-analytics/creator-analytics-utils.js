(function () {
  "use strict";

  function fallbackEscape(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function h(ctx, value) {
    return (ctx.helpers?.escapeHtml || fallbackEscape)(value);
  }

  function a(ctx, value) {
    return (ctx.helpers?.escapeAttr || ctx.helpers?.escapeHtml || fallbackEscape)(value);
  }

  function getReady(ctx) {
    if (ctx.helpers?.getVisibleAccounts) return ctx.helpers.getVisibleAccounts();
    return (ctx.state.accounts || []).filter((x) => x.status === "ready");
  }

  function getProblems(ctx) {
    if (ctx.helpers?.getProblemAccounts) return ctx.helpers.getProblemAccounts();
    return (ctx.state.accounts || []).filter((x) => x.status !== "ready");
  }

  window.OnlinodCreatorAnalyticsUtils = {
    fallbackEscape,
    h,
    a,
    getReady,
    getProblems,
  };
})();
