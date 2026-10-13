(() => {
  'use strict';
  let localLock = Promise.resolve();
  async function request(path, { method = 'GET', body, timeout = 90000 } = {}) {
    if (!path.startsWith('/api/')) throw new Error('API_PATH_REQUIRED');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeout);
    try {
      const multipart = body instanceof FormData;
      const response = await fetch(path, { method, credentials: 'same-origin', redirect: 'error', cache: 'no-store',
        headers: { 'X-NOD-Client': 'website', ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? (multipart ? body : JSON.stringify(body)) : undefined, signal: controller.signal });
      let data;
      try { data = await response.json(); } catch (_) { data = { code: 'SERVER_UNAVAILABLE' }; }
      if (!response.ok || data.ok === false) throw Object.assign(new Error(data.code || 'REQUEST_FAILED'), { code: data.code || 'REQUEST_FAILED', status: response.status, data });
      return data;
    } catch (error) {
      if (error.code) throw error;
      throw Object.assign(new Error('Connection interrupted'), { code: method === 'GET' ? 'NETWORK_UNAVAILABLE' : 'REQUEST_OUTCOME_UNKNOWN' });
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
