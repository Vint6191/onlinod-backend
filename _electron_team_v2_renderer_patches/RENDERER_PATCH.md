# RENDERER PATCH — Team v2

Минимальные изменения в существующих файлах renderer'а. Сохраняем 90% твоего кода, переключаем только источник данных с localStorage на backend API.


## 1) Add new file

Положи `team-analytics-api.js` (из этого пака) в ту же папку где лежат остальные `team-analytics-*.js` файлы.

Подключи в твоём renderer index.html **ПЕРЕД** `team-analytics-state.js`:

```html
<script src="modules/team-analytics/renderer/team-analytics-api.js"></script>
<script src="modules/team-analytics/renderer/team-analytics-state.js"></script>
```


## 2) Patch `team-analytics-state.js`

Найди функцию `loadPersisted()` и **замени** на:

```js
function loadPersisted() {
  // Backed-by-API now. Returns null on first boot — caller will
  // hydrate asynchronously via hydrateFromBackend().
  try {
    const cached = localStorage.getItem(LS_KEY);
    if (cached) return JSON.parse(cached);
  } catch (_) {}
  return null;
}
```

(Оставляем localStorage как **cache** — на offline / для быстрой первой отрисовки. Backend всё равно перезапишет при первом fetch'е.)

Найди функцию `persist(teamAnalytics)` и **замени** на:

```js
function persist(teamAnalytics) {
  if (!teamAnalytics) return;

  const snapshot = {
    customRoles: Array.isArray(teamAnalytics.customRoles) ? teamAnalytics.customRoles : [],
    roleOverrides: teamAnalytics.roleOverrides || {},
    subPermissionOverrides: teamAnalytics.subPermissionOverrides || {},
    memberRoleAssignments: teamAnalytics.memberRoleAssignments || {},
    members: Array.isArray(teamAnalytics.members) ? teamAnalytics.members : [],
    impersonateMemberId: teamAnalytics.impersonateMemberId || null,
  };

  // Cache locally for instant first paint on reload.
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
  } catch (_) {}

  // Backend writes are done by the action endpoints (setRoleAccess →
  // PATCH, deleteMember → DELETE etc). This persist() is just for
  // the local cache.
}
```

Добавь **новую** функцию рядом с persist():

```js
// Hydrate state from backend. Call this on app start AFTER the user
// has logged in and an active agency has been selected. Triggers a
// re-render via the provided rerender callback.
async function hydrateFromBackend(ctx, rerender) {
  const api = window.OnlinodTeamAnalyticsApi;
  if (!api) {
    console.warn("[TEAM] OnlinodTeamAnalyticsApi missing, staying on localStorage");
    return;
  }

  const result = await api.fetchTeamState();
  if (!result?.ok) {
    console.warn("[TEAM] hydrate failed:", result?.error);
    return;
  }

  ensureTeamState(ctx.state);
  const ta = ctx.state.teamAnalytics;

  ta.customRoles = result.customRoles || [];
  ta.roleOverrides = result.roleOverrides || {};
  ta.subPermissionOverrides = result.subPermissionOverrides || {};
  ta.members = result.members || [];
  ta.memberRoleAssignments = result.memberRoleAssignments || {};
  ta.pendingInvitations = result.pendingInvitations || [];
  ta.meMemberId = result.meMemberId || null;
  ta.__hydrated = true;
  ta.__hydratedFromBackend = true;

  // Cache locally for instant next-paint.
  persist(ta);

  if (typeof rerender === "function") rerender();
}
```

Экспортируй её внизу файла, в `window.OnlinodTeamAnalyticsState = {...}`:

```js
window.OnlinodTeamAnalyticsState = {
  ensureTeamState,
  hydrateFromBackend,   // ← добавь сюда
  // ... остальное без изменений
};
```


## 3) Patch `team-analytics-events.js` — invite link

Найди блок (примерно строка 348):

```js
const copyInvite = t.closest("[data-hq-team-copy-invite]");
if (copyInvite && ctx.root.contains(copyInvite)) {
  event.preventDefault();
  const token = `inv_${Math.random().toString(36).slice(2, 12)}`;
  const link = `https://onlinod.app/invite/${token}`;
  // ...
}
```

**Замени** на:

```js
const copyInvite = t.closest("[data-hq-team-copy-invite]");
if (copyInvite && ctx.root.contains(copyInvite)) {
  event.preventDefault();

  // Read invite settings from the button's data attributes (you can
  // wire these from the UI — role select, email field, etc.).
  const roleKey = copyInvite.dataset.hqInviteRole || "chatter";
  const email = copyInvite.dataset.hqInviteEmail || null;

  flashCopied(copyInvite, "creating…");

  try {
    const result = await window.OnlinodTeamAnalyticsApi.createInvitation({
      roleKey,
      email,
      assignedCreators: "all",
    });

    if (!result?.ok) {
      flashCopied(copyInvite, "failed");
      console.error("[TEAM] invite create failed:", result);
      return;
    }

    await navigator.clipboard.writeText(result.url);
    flashCopied(copyInvite, "copied!");

    // Refresh state so the new invitation shows up in pending list.
    if (typeof ctx.actions?.refreshTeam === "function") {
      ctx.actions.refreshTeam();
    }
  } catch (err) {
    console.warn("[TEAM] invite copy failed:", err);
    flashCopied(copyInvite, "copy failed");
  }
  return;
}
```


## 4) Hook `hydrateFromBackend()` into your app start

В твоём `app-start.js` (или где у тебя главный bootstrap renderer'а) после успешного login + загрузки workspace context добавь:

```js
// After auth + activeAgency is known
const rerenderTeam = () => window.OnlinodTeamAnalyticsView?.render?.({
  root: document.getElementById("team-analytics-root"), // или твой контейнер
  state: window.OnlinodAppState,
  helpers: yourHelpers,
  actions: yourActions,
});

await window.OnlinodTeamAnalyticsState.hydrateFromBackend(
  { state: window.OnlinodAppState },
  rerenderTeam
);
```

Если ты сейчас не видишь где это делать — это нормально. Можешь подключить позже, **renderer всё равно будет работать со старым localStorage** пока ты не вызовешь hydrateFromBackend. Просто данные будут локальные.


## 5) (Опционально) — патчи для setRoleAccess, deleteMember и т.д.

Если хочешь чтобы каждое UI-действие сразу сохранялось на бекенд — в `team-analytics-state.js` оберни ключевые мутации в API-вызовы. Пример для `setRoleAccess`:

```js
function setRoleAccess(ctx, roleKey, zoneKey, levelKey) {
  if (!roleKey || !zoneKey || !levelKey) return null;

  // Local mutation (instant UI response)
  const localResult = mutate(ctx, (ta) => {
    // ... existing logic unchanged
  });

  // Async backend sync (fire-and-forget — local state is source of truth
  // until next hydrateFromBackend)
  if (window.OnlinodTeamAnalyticsApi) {
    window.OnlinodTeamAnalyticsApi
      .patchRoleAccess(roleKey, zoneKey, levelKey)
      .then((res) => {
        if (!res?.ok) console.warn("[TEAM] role access sync failed:", res);
      })
      .catch((err) => console.warn("[TEAM] role access sync error:", err));
  }

  return localResult;
}
```

Аналогично можно обернуть: `setSubPermissionOverride`, `clearSubPermissionOverride`, `assignRoleToMember`, `updateMember`, `deleteMember`, `duplicateRole`, `deleteCustomRole`.

Делать это **по одной** функции и тестировать. Не обязательно делать всё сразу — пока без этих патчей у тебя получится: локальный UI (как раньше) + новые invitations через бекенд + hydrate from backend на старте.


## Порядок применения

1. Положи `team-analytics-api.js` рядом с другими team-analytics-* файлами
2. Подключи в `<script>` теге **перед** `team-analytics-state.js`
3. Запатчи `loadPersisted` + `persist` + добавь `hydrateFromBackend` в `team-analytics-state.js`
4. Запатчи invite-link handler в `team-analytics-events.js`
5. Деплой backend (миграция + новые routes)
6. Тестируй invite flow → создаёт реальную ссылку, можно открыть и заклеймить

Шаг 5 (на каждое действие сразу sync на бекенд) — оставь на потом, там всё мелко и легко добавлять по одной функции.
