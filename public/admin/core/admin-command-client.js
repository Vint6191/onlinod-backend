(function () {
  "use strict";
  const memory = new Map();
  function canonical(value) {
    if (!value || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  async function digest(value) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
  }
  function get(key) { try { return JSON.parse(sessionStorage.getItem(key) || "null") || memory.get(key); } catch (_) { return memory.get(key); } }
  function set(key, value) {
    if (value) memory.set(key, value); else memory.delete(key);
    try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch (_) { /* Session-only memory fallback. */ }
  }
  function isCommand(path, method) {
    const operational = (method === "PATCH" && /^\/api\/admin\/(?:agencies\/[^/]+|members\/[^/]+\/(?:role|permissions)|users\/[^/]+)$/.test(path)) || (method === "DELETE" && /^\/api\/admin\/(?:agencies|members|creators)\/[^/]+$/.test(path)) || (method === "POST" && /^\/api\/admin\/(?:agencies\/[^/]+\/restore|users\/[^/]+\/(?:force-logout|reset-password)|devices\/[^/]+\/kick|maintenance\/subscriber-signals\/[^/]+\/requeue)$/.test(path));
    return (method === "PATCH" && path === "/api/admin/system/retention") || (method === "POST" && /^\/api\/admin\/system\/retention\/(?:reset|run)$/.test(path)) || (method === "POST" && /^\/api\/admin\/support\/grants(?:\/[^/]+\/revoke)?$/.test(path)) || operational || (method === "PATCH" && /^\/api\/admin\/(?:billing\/creator\/[^/]+|creators\/[^/]+\/(?:billing|entitlement)|agencies\/[^/]+\/(?:subscription|billing-hold)|admin-users\/[^/]+)$/.test(path)) ||
      (method === "POST" && (/^\/api\/admin\/data\/content\/[^/]+\/lifecycle$/.test(path) || /^\/api\/admin\/data\/creators\/[^/]+\/archive-deliveries$/.test(path) || /^\/api\/admin\/admin-users(?:\/[^/]+\/reset-password)?$/.test(path) || /^\/api\/admin\/billing\/agency\/[^/]+\/apply-tier(?:\/cancel)?$/.test(path)));
  }
  async function prepare({ path, method, body, token }) {
    if (!isCommand(path, method)) return null;
    if (!crypto?.subtle || !crypto?.randomUUID) throw new Error("This browser cannot create durable admin commands");
    const resource = path.replace(/^\/api\/admin\/creators\/([^/]+)\/billing$/, "/api/admin/billing/creator/$1");
    // No token, password, hash of password alone, or request body is persisted.
    const key = `onlinod_admin_pending_v1:${await digest(`${token}\n${method}\n${resource}`)}`;
    const fingerprint = await digest(`${token}\n${canonical(body)}`);
    const previous = get(key);
    if (previous && previous.fingerprint !== fingerprint) {
      return { blocked: true, commandId: previous.commandId, result: { ok: false, code: "ADMIN_COMMAND_UNRESOLVED", commandId: previous.commandId, error: "A previous change has an uncertain result. Check its status or retry the same change before editing again." } };
    }
    const record = previous || { commandId: crypto.randomUUID(), fingerprint };
    set(key, record);
    return { key, ...record };
  }
  function settle(command, response, data) {
    // A proxy HTML error or truncated JSON response does not prove the outcome.
    if (command && response.status < 500 && data && typeof data.ok === "boolean" && !["INVALID_JSON", "ADMIN_COMMAND_RESPONSE_UNKNOWN"].includes(data.code) && !data.text && (data.commandId === command.commandId || (!data.ok && [400, 401, 403, 404, 428].includes(response.status)))) set(command.key, null);
  }
  async function resolve(path, method, token) {
    const resource = path.replace(/^\/api\/admin\/creators\/([^/]+)\/billing$/, "/api/admin/billing/creator/$1");
    const key = `onlinod_admin_pending_v1:${await digest(`${token}\n${method}\n${resource}`)}`;
    const pending = get(key);
    if (!pending) return { ok: true, pending: false };
    const res = await fetch(`/api/admin/commands/${pending.commandId}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (res.ok && data.commandId === pending.commandId && (["SUCCEEDED", "REJECTED"].includes(data.status) || data.result?.accepted === true)) { set(key, null); return { ...data, pending: false }; }
    return { ...data, pending: true, commandId: pending.commandId };
  }
  function redact(value, key = "") {
    if (/password|token|secret|authorization|credential|hash/i.test(key)) return "[redacted]";
    if (Array.isArray(value)) return value.map(item => redact(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
    return value;
  }
  window.OnlinodAdminCommands = { prepare, settle, resolve, redact };
})();
