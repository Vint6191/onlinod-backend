(function () {
  "use strict";
  // Every asynchronous view belongs to a login, a route and a request.
  // Empty results are loaded results; forced reads supersede earlier reads.
  let view = 0;
  const reads = new WeakMap(),
    pending = new Set(),
    timers = new Map(),
    stores = new Set(),
    busy = new WeakSet();
  const token = () => window.NodAdminApi?.getToken() || "";
  function capture(root) {
    const ownView = view,
      ownToken = token();
    return () => ownView === view && ownToken === token() && (!root || root.isConnected !== false);
  }
  function invalidate(state) {
    reads.set(state, (reads.get(state) || 0) + 1);
    state.loading = false;
    state.lastLoadedAt = 0;
  }
  function request(root, key = root) {
    const current = capture(root),
      id = (reads.get(key) || 0) + 1;
    reads.set(key, id);
    return () => current() && reads.get(key) === id;
  }
  function leave() {
    view++;
    for (const state of pending) invalidate(state);
    pending.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    document.querySelectorAll(".adm-modal-overlay, .adm-toast").forEach((node) => node.remove());
  }
  function local(factory) {
    const state = factory();
    stores.add(() => {
      if (state.pollTimer) clearInterval(state.pollTimer);
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, factory());
    });
    return state;
  }
  function reset() {
    leave();
    for (const resetStore of stores) resetStore();
  }
  window.addEventListener("nod:admin-session-changed", reset);
  window.addEventListener("storage", (event) => {
    if (event.key === "onlinod_admin_token" || event.key === null) reset();
  });
  function active(section) {
    return Boolean(token()) && [].concat(section).includes(window.NodAdminState.section);
  }
  function needsRead(state, ttl = 30000) {
    return !state.loading && !state.error && (!state.lastLoadedAt || Date.now() - state.lastLoadedAt >= ttl);
  }
  function paint(section, render) {
    if (!active(section)) return;
    const root = document.getElementById("admMain");
    if (!root) return;
    const focused = document.activeElement,
      id = root.contains(focused) ? focused.id : null;
    const start = focused?.selectionStart,
      end = focused?.selectionEnd;
    render(root);
    if (id) {
      const next = document.getElementById(id);
      if (next && root.contains(next)) {
        next.focus({ preventScroll: true });
        if (start != null && next.setSelectionRange) next.setSelectionRange(start, end);
      }
    }
  }
  async function load({ section, state, force, fetch, apply, render, ttl = 30000 }) {
    if (!active(section)) return;
    if (!force && (state.loading || (state.lastLoadedAt && Date.now() - state.lastLoadedAt < ttl))) return;
    const current = request(null, state);
    if (force) {
      if (Array.isArray(state.list)) state.list = [];
      if (Array.isArray(state.events)) state.events = [];
    }
    state.loading = true;
    state.error = null;
    pending.add(state);
    paint(section, render);
    let result;
    try {
      result = await fetch();
    } catch (error) {
      result = { ok: false, error: error.message };
    }
    if (!current()) return;
    pending.delete(state);
    state.loading = false;
    if (!result?.ok) state.error = result?.error || "Could not load this view. Retry the request.";
    else {
      apply(result);
      state.lastLoadedAt = Date.now();
    }
    paint(section, render);
  }
  function debounce(key, action, delay = 250) {
    clearTimeout(timers.get(key));
    const current = capture();
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        if (current()) action();
      }, delay)
    );
  }
  function failure(root, message, retry) {
    root.replaceChildren();
    const error = document.createElement("div");
    error.className = "adm-error";
    error.textContent = message;
    const button = document.createElement("button");
    button.className = "adm-btn";
    button.textContent = "Retry";
    button.addEventListener("click", retry);
    root.append(error, button);
  }
  function lock(root) {
    const controls = Array.from(root.querySelectorAll("input, select, textarea, button"), (node) => [
      node,
      node.disabled,
    ]);
    controls.forEach(([node]) => {
      node.disabled = true;
    });
    return () =>
      controls.forEach(([node, disabled]) => {
        node.disabled = disabled;
      });
  }
  function superOnly(root, selector) {
    if (window.NodAdminState.admin?.role === "SUPER_ADMIN") return;
    root.querySelectorAll(selector).forEach((node) => {
      node.disabled = true;
      node.title = "Requires SUPER_ADMIN";
    });
  }
  async function action(root, work) {
    if (!root || busy.has(root)) return;
    const current = capture(root),
      unlock = lock(root);
    busy.add(root);
    try {
      return await work(current);
    } finally {
      busy.delete(root);
      unlock();
    }
  }
  window.NodAdminWorkspace = {
    capture,
    request,
    invalidate,
    leave,
    local,
    active,
    paint,
    load,
    needsRead,
    debounce,
    failure,
    lock,
    superOnly,
    action,
  };
})();
