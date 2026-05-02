# RENDERER PATCH — Creator Analytics → Backend

Минимальные изменения в существующих renderer файлах. Сохраняем 95% твоего кода — меняем только источник данных в `creator-analytics-events.js`.

## 1) Положить новый файл

Положи `creator-analytics-backend-api.js` рядом с другими `creator-analytics-*` файлами.

Подключи в твоём renderer index.html **ПЕРЕД** `creator-analytics-events.js`:

```html
<script src="modules/creator-analytics/renderer/creator-analytics-backend-api.js"></script>
<script src="modules/creator-analytics/renderer/creator-analytics-events.js"></script>
```


## 2) Patch `creator-analytics-events.js` — replace `requestNumbersForAccount`

Найди функцию `requestNumbersForAccount` (примерно строка 11). Текущая версия:

```js
async function requestNumbersForAccount(ctx, account, range, { force = false } = {}) {
  if (!account?.id) return null;

  const current = S.getNumbersState(ctx, account.id, range);
  if (!force && (current?.loading || current?.loaded)) {
    return current?.data || null;
  }

  S.setNumbersLoading(ctx, account.id, range, true);
  rerender(ctx);

  try {
    const result = await window.desktopAPI?.creatorAnalytics?.getNumbers?.(account, range);
    // ... old direct-OF call
  }
}
```

**Замени** на:

```js
async function requestNumbersForAccount(ctx, account, range, { force = false } = {}) {
  if (!account?.id) return null;

  const current = S.getNumbersState(ctx, account.id, range);
  if (!force && (current?.loading || current?.loaded)) {
    return current?.data || null;
  }

  S.setNumbersLoading(ctx, account.id, range, true);
  rerender(ctx);

  try {
    // Backend-first: read snapshot from DB.
    const backendApi = window.OnlinodCreatorAnalyticsBackendApi;

    if (backendApi) {
      const result = await backendApi.getCreatorEarnings(account.id, range);

      if (result?.ok && result.snapshot) {
        // Convert backend cents → renderer-friendly dollar floats.
        // (Renderer's old format was already in dollars.)
        const s = result.snapshot;
        const adapted = {
          ok: true,
          accountId: account.id,
          range: { key: s.rangeKey, startDate: s.rangeStartAt, endDate: s.rangeEndAt },
          summary: {
            total: (s.summary?.total || 0) / 100,
            gross: (s.summary?.gross || 0) / 100,
            delta: (s.summary?.delta || 0) / 100,
            avgSale: (s.summary?.avgSale || 0) / 100,
            fanLtv: (s.summary?.fanLtv || 0) / 100,
            salesCount: s.summary?.salesCount || 0,
            uniqueFans: s.summary?.uniqueFans || 0,
          },
          backend: true,
          capturedAt: s.capturedAt,
          staleSeconds: s.staleSeconds || 0,
        };
        S.setNumbersData(ctx, account.id, range, adapted);
        rerender(ctx);
        return adapted;
      }

      if (result?.ok && !result.snapshot) {
        // No data yet on backend — schedule a fetch and show empty state.
        backendApi.refreshCreator(account.id, range).catch(() => {});
        S.setNumbersData(ctx, account.id, range, {
          ok: true,
          accountId: account.id,
          range: { key: range },
          summary: { total: 0, gross: 0, delta: 0, avgSale: 0, fanLtv: 0, salesCount: 0, uniqueFans: 0 },
          backend: true,
          empty: true,
          capturedAt: null,
          staleSeconds: null,
        });
        rerender(ctx);
        return null;
      }

      // Backend error — fall through to old IPC path as fallback.
      console.warn("[CREATOR_ANALYTICS] backend earnings failed, falling back to direct OF:", result?.error);
    }

    // Fallback: direct OF call via main process (old behavior).
    const result = await window.desktopAPI?.creatorAnalytics?.getNumbers?.(account, range);

    if (!result?.ok) {
      S.setNumbersError(ctx, account.id, range, result?.error || "Failed to load creator numbers");
      rerender(ctx);
      return null;
    }

    S.setNumbersData(ctx, account.id, range, result);
    rerender(ctx);
    return result;
  } catch (err) {
    S.setNumbersError(ctx, account.id, range, String(err?.message || err));
    rerender(ctx);
    return null;
  }
}
```


## 3) Patch `loadCampaignsForSelected` — same idea

Найди функцию `loadCampaignsForSelected`. Текущая использует `desktopAPI.creatorCampaigns.list`. **Замени** тело try-блока на:

```js
try {
  const range = S.getRange(ctx);
  const backendApi = window.OnlinodCreatorAnalyticsBackendApi;

  if (backendApi) {
    const result = await backendApi.getCreatorCampaigns(account.id);

    if (result?.ok && result.snapshot) {
      const adapted = {
        ok: true,
        accountId: account.id,
        range: { key: result.snapshot.rangeKey || range },
        campaigns: result.snapshot.campaigns || [],
        backend: true,
        capturedAt: result.snapshot.capturedAt,
        staleSeconds: result.snapshot.staleSeconds || 0,
      };
      S.setCampaignsData(ctx, account.id, adapted);
      rerender(ctx);
      return adapted;
    }

    if (result?.ok && !result.snapshot) {
      backendApi.refreshCreator(account.id, range).catch(() => {});
      S.setCampaignsData(ctx, account.id, { campaigns: [], backend: true, empty: true });
      rerender(ctx);
      return null;
    }
  }

  // Fallback to old IPC
  const api = window.desktopAPI?.creatorCampaigns;
  if (!api || typeof api.list !== "function") {
    S.setCampaignsData(ctx, account.id, { campaigns: [], notWired: true });
    rerender(ctx);
    return null;
  }

  const result = await api.list(account, range);
  if (!result?.ok) {
    S.setCampaignsError(ctx, account.id, result?.error || "Failed to load campaigns");
    rerender(ctx);
    return null;
  }

  S.setCampaignsData(ctx, account.id, result);
  rerender(ctx);
  return result;
} catch (err) {
  S.setCampaignsError(ctx, account.id, String(err?.message || err));
  rerender(ctx);
  return null;
}
```


## 4) Optional — UI hint "last updated X min ago"

Twoя `creator-analytics-renderers.js` сейчас показывает заработок. Если хочешь добавить "last updated" badge — найди место где рендерится числа и проверь `state.data.staleSeconds` / `state.data.backend / state.data.empty`. Это **опционально** — renderer работает и без этого, просто без UX-фишки.

Пример:

```js
const numbersState = ctx.state.creatorAnalytics.numbersByAccountId[accountId]?.[range];
const data = numbersState?.data;

if (data?.empty) {
  // Show "No data yet · refreshing..." state
}
if (data?.staleSeconds && data.staleSeconds > 600) {
  // Show "last updated 12 min ago" badge
}
```


## 5) Для admin — кнопка force refresh

Если хочешь кнопку «обновить сейчас» — найди button в renderer'е range dropdown'а (или где удобно) и добавь handler:

```js
const refreshBtn = target.closest("[data-hq-creator-refresh]");
if (refreshBtn && ctx.root.contains(refreshBtn)) {
  event.preventDefault();
  const accountId = S.getSelectedCreatorId(ctx);
  if (accountId) {
    const range = S.getRange(ctx);
    const result = await window.OnlinodCreatorAnalyticsBackendApi.refreshCreator(accountId, range);
    if (result?.ok) {
      // Force reload after a small delay — backend needs a few seconds
      // for the chatter machine to claim the job and report back.
      setTimeout(() => loadNumbers(ctx, { force: true }), 5000);
      setTimeout(() => loadCampaignsForSelected(ctx, { force: true }), 5000);
    }
  }
  return;
}
```


## После применения

1. Деплой backend
2. Перезапуск Electron
3. Heartbeat начинает шуршать (как было)
4. Jobs runner подключается к heartbeat'у — каждые 30 сек дёргает claim
5. Когда creator есть в Bindings, owner UI показывает данные из БД (могут быть пустыми пока chatter не выполнит первый job)
6. Owner кликает refresh → ставится job с priority=100 → следующий tick подхватит → результат летит в БД → следующий tick UI заберёт

Если backend не отвечает — fallback на старый IPC к OF (как было). Это чтобы тебе не сломать локальный workflow если деплой backend упал.
