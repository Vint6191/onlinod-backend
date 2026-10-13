(() => {
  'use strict';
  let localLock = Promise.resolve();
  class APIError extends Error {
    constructor(code, details = {}) { super(code); this.code = code; Object.assign(this, details); }
  }
  async function request(path, { method = 'GET', body, timeout = 90000 } = {}) {
    if (!path.startsWith('/api/')) throw new Error('API_PATH_REQUIRED');
    method = method.toUpperCase();
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const multipart = body instanceof FormData;
      const response = await fetch(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'X-NOD-Client': 'website', ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? (multipart ? body : JSON.stringify(body)) : undefined, signal: controller.signal });
      // A truncated JSON body or a proxy's HTML page is not a server receipt,
      // even when its HTTP status is 200. Never replay a mutation to find out.
      const data = await response.json();
      if (!data || Array.isArray(data) || typeof data !== 'object' || typeof data.ok !== 'boolean') throw new Error('INVALID_API_RECEIPT');
      if (!response.ok || data.ok === false) throw new APIError(typeof data.code === 'string' ? data.code : 'REQUEST_FAILED', { status: response.status, data });
      return data;
    } catch (error) {
      // DOMException.code is a number (e.g. 20 for AbortError), not an API code.
      if (error instanceof APIError) throw error;
      throw new APIError(method === 'GET' || method === 'HEAD' ? 'NETWORK_UNAVAILABLE' : 'REQUEST_OUTCOME_UNKNOWN');
    } finally { clearTimeout(timer); }
  }
  function sessionLock(work) {
    if (navigator.locks) return navigator.locks.request('nod-website-session', work);
    const next = localLock.then(work, work); localLock = next.catch(() => {}); return next;
  }
  async function session() {
    return sessionLock(async () => {
      try { return await request('/api/web/auth/me'); }
      catch (error) { if (error.status !== 401) throw error; }
      await request('/api/web/auth/refresh', { method: 'POST', body: {} });
      return request('/api/web/auth/me');
    });
  }
  window.NODWeb = Object.freeze({ request, sessionLock, session });
})();
