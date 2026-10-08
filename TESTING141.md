# Проверка исходников 141

Проверенная среда: Node 22.23.3, npm, Linux. Пакет содержит исходники и тесты, а не Windows-установщик. Нативные Electron/Windows и многосессионные PostgreSQL-проверки требуют отдельного окружения.

Все команды выполняются в изолированной копии проекта без production-подключений. `npm run test:all` обнаруживает все `*.test`/`*.spec` с расширениями js/mjs/cjs, включая каталоги вне src; исключает node_modules, dist и .git. Не используйте production DATABASE_URL для тестов. Интеграционные тесты сохраняют собственные условия запуска и отмечаются SKIP без нужного окружения.

1. Установите зависимости Backend и Desktop через `npm ci` под Node 22. В Desktop выполните `npm run build` и `npm run typecheck`.
2. Для запуска SQLite-тестов вне Electron в отдельной тестовой копии Desktop выполните `npm rebuild better-sqlite3 --build-from-source`. Для запуска самого Electron после этих тестов восстановите ABI командой `npm run rebuild:native`. Не переносите node_modules из тестовой копии в установленное приложение.
3. Создайте отдельный локальный каталог SQL-стенда с зависимостями `@electric-sql/pglite@0.5.8` и `@electric-sql/pglite-socket@0.2.11`. В переменной ONLINOD_SQL_PROOF_RUNTIME задайте абсолютный путь этого каталога. Стенд создаёт свою одноразовую БД и применяет обычный retained-schema план; destructive Phase 7 не запускается.
4. Задайте ONLINOD_BACKEND_ROOT и ONLINOD_DESKTOP_ROOT абсолютными путями двух проектов, а ONLINOD_CAMPAIGN_EVIDENCE — абсолютным путём отдельного каталога результатов. Из Backend запустите:

```sh
node scripts/audit/campaign-read/proof.cjs
node scripts/audit/destructive-control-state-proof.cjs
npm run test:auth-sql
npm run test:all
```

5. Из собранного Desktop с теми же ONLINOD_* переменными запустите `npm run test:all`. Он использует четыре ответа, полученные настоящими SQL-чтениями Backend, и выполняет также проверку их совместимости с Desktop. Отсутствие этих файлов — ошибка, а не молчаливый пропуск. Порядок подготовки переменных зависит от вашей оболочки; значения должны быть абсолютными путями.

`node scripts/test-all.cjs --list` печатает точный список обнаруженных тестовых файлов без запуска. Отдельные старые gate-команды продолжают проверять только свои области. Зелёный полный JS-прогон не означает, что пропущенные интеграционные и нативные проверки пройдены.
