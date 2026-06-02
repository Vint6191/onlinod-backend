# ONLINOD backend server stores v1

Локальный импорт специально не добавлен.

## Что ставить
Скопировать файлы из архива в корень `onlinod-backend-main` с заменой.

## После замены
```bash
npm install
npx prisma migrate deploy
# или для dev:
npx prisma migrate dev --name server_stores_v1
npm run start
```

## Новые API
Все под authRequired:

- `/api/server/content/*` — Message Library / Bumps / Campaign drafts content store.
- `/api/server/crm/*` — CRM profiles, normalized tags, raw tags, notes, analysis runs, filter options.
- `/api/server/fan-lists/*` — списки пользователей.
- `/api/server/segments/*` — сохранённые сегменты/фильтры.
- `/api/server/campaigns/*` — черновики кампаний и OF queue status.
- `/api/server/automation/*` — delivery log, hidden-online pool, follow-back tasks.
- `/api/server/vault-sales/*` — purchase messages, media sales, summary.

## Что НЕ переносится на сервер
- OF cookies / partition/session
- raw chat messages
- raw websocket frames
- binary media files
- UI state / scroll positions

Медиа хранится как metadata/IDs: `media_id`, `type`, `thumb`, `duration`, etc.
