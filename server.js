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
    if (ctx.helpers?.getVisibleAccounts) {
      return ctx.helpers.getVisibleAccounts();
    }

    return (ctx.state.accounts || []).filter((x) => x.status === "ready");
  }

  function getProblems(ctx) {
    if (ctx.helpers?.getProblemAccounts) {
      return ctx.helpers.getProblemAccounts();
    }

    return (ctx.state.accounts || []).filter((x) => x.status !== "ready");
  }

  function sumField(list, field) {
    return list.reduce((acc, item) => acc + Number(item?.[field] || 0), 0);
  }

  function accountName(ctx, account) {
    if (ctx.helpers?.accountPublicName) {
      return ctx.helpers.accountPublicName(account);
    }

    return (
      account?.displayName ||
      account?.name ||
      account?.username ||
      "Account"
    );
  }

  function accountAvatar(ctx, account, className) {
    if (ctx.helpers?.accountCardAvatarHtml) {
      return ctx.helpers.accountCardAvatarHtml(account, className);
    }

    const avatar =
      account?.avatar ||
      account?.avatarThumb ||
      account?.avatarThumbs?.c144 ||
      account?.avatarThumbs?.c50 ||
      "";

    const initial = String(accountName(ctx, account)).trim().slice(0, 1).toUpperCase() || "A";

    if (avatar) {
      return `<img class="${className}" src="${a(ctx, avatar)}" alt="">`;
    }

    return `<div class="${className} fallback">${h(ctx, initial)}</div>`;
  }

  function statusLabel(ctx, account) {
    if (ctx.helpers?.accountStatusLabel) {
      return ctx.helpers.accountStatusLabel(account);
    }

    if (account?.status === "ready") return "READY";
    if (account?.status === "checking") return "CHECKING";
    if (account?.status === "not_creator") return "NOT CREATOR";
    if (account?.status === "auth_failed") return "AUTH FAILED";
    return "WAIT LOGIN";
  }

  function formatCount(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return "0";
    return String(n);
  }

  window.OnlinodHomeUtils = {
    h,
    a,
    fallbackEscape,
    getReady,
    getProblems,
    sumField,
    accountName,
    accountAvatar,
    statusLabel,
    formatCount,
  };
})();
