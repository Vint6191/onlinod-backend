# ELECTRON MAIN PATCH — wire jobs-runner

Минимальные изменения в `electron/index.js` для подключения jobs-runner.


## 1) Положить новый файл

```
electron/jobs-runner.js     ← из этого пака (или electron/main/ — где у тебя heartbeat-runner)
```


## 2) Импорт наверху index.js

Рядом с импортом heartbeat-runner:

```js
const { startJobsRunner, stopJobsRunner } = require("./jobs-runner");
```


## 3) Helper `ensureJobsRunning()`

Добавь рядом с `ensureHeartbeatRunning()`:

```js
let jobsRunner = null;

function ensureJobsRunning() {
  if (jobsRunner) return jobsRunner;

  jobsRunner = startJobsRunner({
    getBackendAuthClient,
    backendAuthSessionStore,
    verbose: false,

    // Read account manifest by id (already in index.js).
    readAccountManifest: (accountId) => {
      try { return readAccountManifest(String(accountId || "")); } catch { return null; }
    },

    // These two functions ALREADY exist in your index.js — pass them through.
    getCreatorNumbersPayload,
    getCreatorCampaignsPayload,
  });

  return jobsRunner;
}
```


## 4) Hook into login/logout flows

**Wherever you call `ensureHeartbeatRunning()` — also call `ensureJobsRunning()`** right after. So in `backend:ensure-session`, `backend:login`, `backend:register`:

```js
ipcMain.handle("backend:ensure-session", async () => {
  try {
    const result = await getBackendAuthClient().ensureSession();
    if (result?.ok) {
      ensureHeartbeatRunning();
      ensureJobsRunning();      // ← add this line
    }
    return result;
  } catch (err) { /* ... */ }
});
```

(same for backend:login and backend:register)

And on logout:

```js
ipcMain.handle("backend:logout", async () => {
  try {
    const result = await getBackendAuthClient().logout();
    stopHeartbeatRunner();
    stopJobsRunner();           // ← add this line
    return result;
  } catch (err) {
    try { backendAuthSessionStore?.clear?.(); } catch (_) {}
    stopHeartbeatRunner();
    stopJobsRunner();           // ← and here
    return { ok: true, localOnly: true };
  }
});
```


## 5) (Опциональный) — кнопка "refresh" в renderer

Уже описано в `RENDERER_PATCH.md`. По сути renderer вызывает `OnlinodCreatorAnalyticsBackendApi.refreshCreator(creatorId, range)` → backend помечает job как priority=100 → следующий tick jobs-runner'а (≤30 сек) подберёт → выполнит → отправит upsert → UI через 5 сек дернёт `loadNumbers({ force: true })` и увидит свежие данные.


## После применения

1. Перезапуск Electron
2. Heartbeat начинает идти (как было)
3. Через ~15 сек после старта — первый tick jobs-runner'а
4. Если на бекенде есть scheduled jobs (например после `creator-connect status=READY` auto-schedule, или после кнопки refresh) — jobs-runner их выполнит
5. Owner UI читает из БД → видит свежие данные

Логи (`verbose: true` в `ensureJobsRunning`) — чтобы видеть когда jobs claim'ятся и выполняются.


## Тест end-to-end (после полного деплоя)

```bash
# 1. Backend задеплоен (миграция + routes), schema regenerated
# 2. Electron — heartbeat работает (видишь себя в /admin/devices как online)

# 3. Дёрни refresh для одного из своих creator'ов:
TOKEN=<твой user token>
BASE=https://onlinod-backend.onrender.com
CREATOR_ID=<id ready creator'а>

curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"rangeKey":"7d"}' \
     "$BASE/api/stats/creators/$CREATOR_ID/refresh" | jq

# 4. Подожди ~30-60 секунд (jobs tick + actual fetch + upsert)

# 5. Прочитай результат:
curl -H "Authorization: Bearer $TOKEN" \
     "$BASE/api/stats/creators/$CREATOR_ID/earnings?range=7d" | jq

# Должен видеть { ok: true, snapshot: { summary: { total: ... }, capturedAt: ... } }
```
