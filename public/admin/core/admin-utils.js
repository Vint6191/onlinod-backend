/* public/admin/core/admin-utils.js
   ────────────────────────────────────────────────────────────
   Shared formatters / renderers used across multiple modules.
   Kept tiny — only things needed by ≥2 pages live here.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const R = () => window.OnlinodAdminRouter;

  function formatMoneyFromCents(cents) {
    const n = Number(cents || 0);
    if (!Number.isFinite(n)) return "$0";
    return `$${(n / 100).toFixed(2)}`;
  }

  function formatNumber(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return "0";
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}m`;
    if (n >= 10000)   return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
  }

  function formatDate(value) {
    if (!value) return "—";
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toISOString().slice(0, 10);
    } catch (_) { return "—"; }
  }

  function formatDateTime(value) {
    if (!value) return "—";
    try {
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return "—";
      return d.toISOString().slice(0, 16).replace("T", " ");
    } catch (_) { return "—"; }
  }

  function timeAgo(value) {
    if (!value) return "—";
    const d = new Date(value);
    const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
    if (seconds < 60)        return `${seconds}s ago`;
    if (seconds < 3600)      return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400)     return `${Math.floor(seconds / 3600)}h ago`;
    if (seconds < 604800)    return `${Math.floor(seconds / 86400)}d ago`;
    return formatDate(value);
  }

  // Subscription status → pill class
  function statusPillClass(status) {
    const s = String(status || "").toUpperCase();
    if (s === "ACTIVE")    return "ok";
    if (s === "TRIAL")     return "info";
    if (s === "GRACE")     return "warn";
    if (s === "PAST_DUE")  return "warn";
    if (s === "LOCKED")    return "crit";
    if (s === "CANCELLED") return "muted";
    return "muted";
  }

  function statusPill(status) {
    const r = R();
    const cls = statusPillClass(status);
    return `<span class="adm-pill ${cls}">${r.escapeHtml(String(status || "—").toLowerCase())}</span>`;
  }

  function healthBadge(health) {
    if (!health) return "—";
    const r = R();
    const cls = health.level === "healthy" ? "" : health.level === "warning" ? "warn" : "crit";
    return `
      <span class="adm-health ${cls}">
        <span class="adm-health-bar"><span class="adm-health-bar-fill" style="width:${Math.max(2, health.score)}%"></span></span>
        <span class="adm-health-num">${r.escapeHtml(String(health.score))}</span>
      </span>
    `;
  }

  // Tiny first-letter avatar for entities without a real avatar URL.
  function letterAvatar(name, size = 28) {
    const r = R();
    const ch = String(name || "?").trim().slice(0, 1).toUpperCase() || "?";
    return `
      <div style="
        width:${size}px;height:${size}px;border-radius:7px;
        display:grid;place-items:center;flex-shrink:0;
        background:linear-gradient(135deg,#fbbf24,#f59e0b);
        color:#0a0715;font-weight:800;font-size:${Math.round(size * 0.45)}px;
        font-family:var(--adm-mono);
      ">${r.escapeHtml(ch)}</div>
    `;
  }

  window.OnlinodAdminUtils = {
    formatMoneyFromCents,
    formatNumber,
    formatDate,
    formatDateTime,
    timeAgo,
    statusPillClass,
    statusPill,
    healthBadge,
    letterAvatar,
  };
})();
