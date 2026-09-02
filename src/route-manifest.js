"use strict";

/**
 * Audit16 production route contract.
 *
 * This manifest classifies the 46 product/admin/public families mounted by
 * src/server.js. It intentionally describes authority at the family boundary;
 * narrower sub-routes may add stronger permission/device requirements.
 * LEGACY_GONE families remain mounted only as authenticated 410 compatibility
 * tombstones for one release window and must never regain product handlers.
 */
const ROUTE_CLASS = Object.freeze({
  PUBLIC: "PUBLIC",
  ADMIN: "ADMIN",
  AGENCY: "AGENCY",
  CREATOR: "CREATOR",
  DEVICE: "DEVICE",
  CREATOR_DEVICE: "CREATOR_DEVICE",
  OWNER: "OWNER",
  LEGACY_GONE: "LEGACY_GONE",
});

const route = (path, className, source, authority, extra = {}) => Object.freeze({
  path,
  class: className,
  source,
  authority,
  ...extra,
});

const ROUTE_MANIFEST = Object.freeze([
  route("/api/system", ROUTE_CLASS.PUBLIC, "routes/system.js", "public system health/version contract"),
  route("/api/auth", ROUTE_CLASS.PUBLIC, "routes/auth.js", "authentication/enrollment boundary"),
  route("/api/admin-auth", ROUTE_CLASS.ADMIN, "routes/admin-auth.js", "admin authentication"),
  route("/api/admin/data", ROUTE_CLASS.ADMIN, "routes/admin-data.js", "admin authorization"),
  route("/api/admin/billing", ROUTE_CLASS.ADMIN, "routes/admin-billing.js", "admin authorization"),
  route("/api/admin", ROUTE_CLASS.ADMIN, "routes/admin.js", "admin authorization"),
  route("/api/impersonate", ROUTE_CLASS.ADMIN, "routes/impersonate.js", "admin impersonation authority"),
  route("/api/workspace", ROUTE_CLASS.AGENCY, "routes/workspace.js", "current AgencyMember + workspace permissions"),
  route("/api/devices", ROUTE_CLASS.DEVICE, "routes/devices.js", "authenticated user/device lifecycle"),
  route("/api/team", ROUTE_CLASS.AGENCY, "routes/team.js", "current AgencyMember + canonical team permissions"),
  route("/api/invitations", ROUTE_CLASS.AGENCY, "routes/invitations.js", "workspace membership/invitation authority"),
  route("/api/stats", ROUTE_CLASS.CREATOR_DEVICE, "routes/stats.js", "creator scope + canonical analytics permissions; device binding on machine ingress"),
  route("/api/jobs", ROUTE_CLASS.DEVICE, "routes/jobs.js", "authenticated device work authority"),
  route("/api/of-request-gate", ROUTE_CLASS.DEVICE, "routes/of-request-gate.js", "authenticated device request-gate authority"),
  route("/api/telemetry", ROUTE_CLASS.DEVICE, "routes/telemetry.js", "authenticated telemetry/device provenance"),
  route("/api/analytics", ROUTE_CLASS.LEGACY_GONE, "routes/analytics.js", "410 tombstone; AnalyticsSnapshot is non-authoritative archive", { replacement: "/api/home + /api/stats" }),
  route("/api/traffic", ROUTE_CLASS.CREATOR_DEVICE, "routes/traffic.js", "creator scope + traffic.* permissions; device binding on machine ingress"),
  route("/api/subscribers", ROUTE_CLASS.CREATOR, "routes/subscribers.js", "creator scope + automation.manage for mutations"),
  route("/api/fan-data", ROUTE_CLASS.CREATOR, "routes/fan-data.js", "canonical creator scope"),
  route("/api/automation", ROUTE_CLASS.CREATOR_DEVICE, "routes/automation-control.js", "creator scope + canonical automation permissions + execution device"),
  route("/api/server/content", ROUTE_CLASS.CREATOR_DEVICE, "routes/content-store.js", "current Message Library authority; generic collections are 410 tombstones", { retiredSubroutes: ["/collections", "/collections/:id", "/collections/:id/blocks", "/collections/:id/usage"] }),
  route("/api/server/crm", ROUTE_CLASS.LEGACY_GONE, "routes/crm-store.js", "410 tombstone; historical/admin archive only", { replacement: "Desktop local CRM authority" }),
  route("/api/server/fan-lists", ROUTE_CLASS.LEGACY_GONE, "routes/fan-lists.js", "410 tombstone; historical/archive only", { replacement: "current MASS local audience pipeline" }),
  route("/api/server/segments", ROUTE_CLASS.LEGACY_GONE, "routes/segments.js", "410 tombstone; historical/archive only", { replacement: "current MASS local audience pipeline" }),
  route("/api/server/campaigns", ROUTE_CLASS.LEGACY_GONE, "routes/campaigns.js", "410 tombstone; historical/archive only", { replacement: "current MASS CreatorApiRuntime queue" }),
  route("/api/server/automation", ROUTE_CLASS.CREATOR_DEVICE, "routes/automation-store.js", "current automation configuration/history authority; legacy execution subroutes unmounted"),
  route("/api/dialog-intelligence", ROUTE_CLASS.CREATOR_DEVICE, "routes/dialog-intelligence.js", "creator scope + signed device + access-fenced batch lease"),
  route("/api/custom-orders", ROUTE_CLASS.CREATOR_DEVICE, "routes/custom-orders.js", "creator scope + feature permissions + signed device on machine work"),
  route("/api/server/vault-sales", ROUTE_CLASS.LEGACY_GONE, "routes/vault-sales.js", "410 tombstone; historical/admin archive only", { replacement: "Vault/Media Library + local dialog history" }),
  route("/api/server/vault-directory", ROUTE_CLASS.CREATOR_DEVICE, "routes/vault-directory.js", "creator scope + content.manage_vault for user mutations"),
  route("/api/server/media-library", ROUTE_CLASS.CREATOR_DEVICE, "routes/media-library.js", "creator scope + content.manage_vault for user mutations; signed device for projection ingress"),
  route("/api/server/diagnostics", ROUTE_CLASS.LEGACY_GONE, "routes/server-store-diagnostics.js", "410 tombstone; no customer diagnostics surface", { replacement: "admin-auth diagnostics if needed" }),
  route("/api/home", ROUTE_CLASS.AGENCY, "routes/home.js", "current member + creator scope + section-specific canonical permissions"),
  route("/api/team/analytics", ROUTE_CLASS.AGENCY, "routes/team-analytics.js", "team analytics permissions + allowed creator scope"),
  route("/api/team/claims", ROUTE_CLASS.AGENCY, "routes/team-claims.js", "team claim authority + allowed creator scope"),
  route("/api/team/schedule", ROUTE_CLASS.AGENCY, "routes/team-schedule.js", "team schedule authority"),
  route("/api/audit", ROUTE_CLASS.LEGACY_GONE, "routes/audit.js", "410 tombstone; generic agency audit feed retired", { replacement: "/api/team permission-gated audit" }),
  route("/api/modules", ROUTE_CLASS.LEGACY_GONE, "routes/modules.js", "410 tombstone; ModuleSetting remains internal product storage", { replacement: "dedicated product control APIs" }),
  route("/api/billing", ROUTE_CLASS.OWNER, "routes/billing.js", "owner/billing authority"),
  route("/api/settings", ROUTE_CLASS.AGENCY, "routes/settings.js", "current member/settings permissions; Telegram runtime subroutes are device-bound", { retiredSubroutes: ["/runtime"] }),
  route("/api/message-library", ROUTE_CLASS.LEGACY_GONE, "routes/message-library.js", "410 tombstone; legacy MessageTemplate generation retired", { replacement: "/api/server/content/message-library" }),
  route("/api/creators", ROUTE_CLASS.CREATOR_DEVICE, "routes/creators.js", "creator enrollment/access authority + authenticated device where required"),
  route("/api/creator-sessions", ROUTE_CLASS.CREATOR_DEVICE, "routes/creator-sessions.js", "canonical creator session authority + authenticated device"),
  route("/api/desktop", ROUTE_CLASS.DEVICE, "routes/desktop.js", "desktop bootstrap/accessEpoch/device authority"),
  route("/api/network-profiles", ROUTE_CLASS.CREATOR_DEVICE, "routes/network-profiles.js", "creator network profile authority + authenticated device"),
  route("/api/client-e2e-keyring", ROUTE_CLASS.DEVICE, "routes/client-e2e-keyring.js", "signed device/keyring authority"),
]);

module.exports = { ROUTE_CLASS, ROUTE_MANIFEST };
