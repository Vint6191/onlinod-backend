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
    if (window.CustomEvent) window.dispatchEvent?.(new window.CustomEvent("nod:admin-commands-changed"));
  }
  function forgetIfCurrent(command) {
    if (command?.key && get(command.key)?.commandId === command.commandId) set(command.key, null);
  }
  function isCommand(path, method) {
    const operational = (method === "PATCH" && /^\/api\/admin\/(?:agencies\/[^/]+|members\/[^/]+\/(?:role|permissions)|users\/[^/]+)$/.test(path)) || (method === "DELETE" && /^\/api\/admin\/(?:agencies|members|creators)\/[^/]+$/.test(path)) || (method === "POST" && /^\/api\/admin\/(?:agencies\/[^/]+\/restore|users\/[^/]+\/(?:force-logout|reset-password)|devices\/[^/]+\/kick|maintenance\/subscriber-signals\/[^/]+\/requeue)$/.test(path));
    return (method === "PATCH" && path === "/api/admin/billing/commercial-policy") || (method === "PATCH" && path === "/api/admin/system/retention") || (method === "POST" && /^\/api\/admin\/system\/retention\/(?:reset|run)$/.test(path)) || (method === "POST" && /^\/api\/admin\/support\/grants(?:\/[^/]+\/revoke)?$/.test(path)) || operational || (method === "PATCH" && /^\/api\/admin\/(?:billing\/creator\/[^/]+|creators\/[^/]+\/(?:billing|entitlement)|agencies\/[^/]+\/(?:subscription|billing-hold)|admin-users\/[^/]+)$/.test(path)) ||
      (method === "POST" && (/^\/api\/admin\/data\/content\/[^/]+\/lifecycle$/.test(path) || /^\/api\/admin\/data\/creators\/[^/]+\/archive-deliveries$/.test(path) || /^\/api\/admin\/admin-users(?:\/[^/]+\/reset-password)?$/.test(path) || /^\/api\/admin\/billing\/agency\/[^/]+\/apply-tier(?:\/cancel)?$/.test(path)));
  }
  async function prepare({ path, method, body, token }) {
    if (!isCommand(path, method)) return null;
    if (!crypto?.subtle || !crypto?.randomUUID) throw new Error("This browser cannot create durable admin commands");
    const resource = path.replace(/^\/api\/admin\/creators\/([^/]+)\/billing$/, "/api/admin/billing/creator/$1");
    // No token, password, hash of password alone, or request body is persisted.
    const actor = window.NodAdminState?.admin?.id || token;
    const key = `onlinod_admin_pending_v1:${await digest(`${actor}\n${method}\n${resource}`)}`;
    const fingerprint = await digest(`${token}\n${canonical(body)}`);
    const owner = await digest(actor);
    const legacyKey = `onlinod_admin_pending_v1:${await digest(`${token}\n${method}\n${resource}`)}`;
    const previous = get(key) || get(legacyKey);
    // No asynchronous gap between reading and reserving the journal slot.
    const matches = previous?.fingerprint === fingerprint;
    if (previous && !matches) {
      return { blocked: true, commandId: previous.commandId, result: { ok: false, code: "ADMIN_COMMAND_UNRESOLVED", commandId: previous.commandId, error: "A previous change has an uncertain result. Check its status or retry the same change before editing again." } };
    }
    const record = { ...(previous || { commandId: crypto.randomUUID() }), fingerprint, owner, path: resource, method,
      createdAt: previous?.createdAt || new Date().toISOString(), attempts: (previous?.attempts || 0) + 1 };
    set(key, record);
    if (legacyKey !== key && get(legacyKey)?.commandId === record.commandId) set(legacyKey, null);
    return { key, ...record, hadPending: Boolean(previous) };
  }
  function settle(command, response, data) {
    // A proxy HTML error or truncated JSON response does not prove the outcome.
    if (!command || response.status < 200 || response.status >= 500 || !data || typeof data.ok !== "boolean" || ["INVALID_JSON", "ADMIN_COMMAND_RESPONSE_UNKNOWN"].includes(data.code) || data.text) return;
    const current = get(command.key);
    // A denied retry does not establish the outcome of an earlier request.
    // An old reply also must not erase a newer intent on the same resource.
    const firstValidation = !command.hadPending && current?.attempts === 1 && !data.ok && data.commandId == null && [400, 404, 428].includes(response.status);
    if (data.commandId === command.commandId || firstValidation) forgetIfCurrent(command);
  }
  async function resolve(path, method, token) {
    const resource = path.replace(/^\/api\/admin\/creators\/([^/]+)\/billing$/, "/api/admin/billing/creator/$1");
    const actor = window.NodAdminState?.admin?.id || token;
    let key = `onlinod_admin_pending_v1:${await digest(`${actor}\n${method}\n${resource}`)}`;
    if (!get(key)) key = `onlinod_admin_pending_v1:${await digest(`${token}\n${method}\n${resource}`)}`;
    const pending = get(key);
    if (!pending) return { ok: true, pending: false };
    const res = await fetch(`/api/admin/commands/${pending.commandId}`, { headers: { Authorization: `Bearer ${token}` } });
    const data = await res.json();
    if (res.ok && data.commandId === pending.commandId && (["SUCCEEDED", "REJECTED"].includes(data.status) || data.result?.accepted === true)) { forgetIfCurrent({ key, commandId: pending.commandId }); return { ...data, pending: Boolean(get(key)) }; }
    return { ...data, pending: true, commandId: pending.commandId };
  }
  async function pending(token) {
    const owner = await digest(window.NodAdminState?.admin?.id || token);
    const keys = new Set(memory.keys());
    try { for (let i = 0; i < sessionStorage.length; i++) keys.add(sessionStorage.key(i)); } catch (_) {}
    return Array.from(keys).filter(key => key?.startsWith("onlinod_admin_pending_v1:")).map(get)
      .filter(item => item?.owner === owner && item.path && item.method)
      .map(({ commandId, path, method, createdAt }) => ({ commandId, path, method, createdAt }));
  }
  function redact(value, key = "") {
    if (/password|token|secret|authorization|credential|hash/i.test(key)) return "[redacted]";
    if (Array.isArray(value)) return value.map(item => redact(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
    return value;
  }
  window.NodAdminCommands = { prepare, settle, resolve, pending, redact };
})();
