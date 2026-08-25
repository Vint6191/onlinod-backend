"use strict";

/**
 * Чистка ЗАСТРЯВШИХ бампов AutomationDelivery.
 *
 * Контекст: остались старые майские бампы в статусах pending_reply / checking_reply,
 * которые sweep не может закрыть (ошибка "Browser tab for account not found"),
 * потому что вкладка аккаунта закрыта. Они уже не отправляются и не нужны.
 *
 * Что делает: удаляет записи, у которых
 *   - статус входит в список «незавершённых» (по умолчанию pending_reply, checking_reply, scheduled)
 *   - И возраст (по sentAt, либо createdAt если sentAt пуст) больше порога (по умолчанию 7 дней).
 *
 * Свежие записи и записи в финальных статусах (replied, canceled, sent, failed) НЕ трогаются.
 *
 * Запуск:
 *   node scripts/maintenance/purge-stuck-deliveries.js                 -> DRY-RUN (только покажет)
 *   node scripts/maintenance/purge-stuck-deliveries.js --apply         -> реально удалит
 *   node scripts/maintenance/purge-stuck-deliveries.js --days=3 --apply -> другой порог возраста
 *   node scripts/maintenance/purge-stuck-deliveries.js --all --apply    -> игнорировать возраст, снести все застрявшие
 */

// Подхватываем тот же Prisma singleton, что и production backend.
const prisma = require("../../src/prisma");

const APPLY = process.argv.includes("--apply");
const ALL = process.argv.includes("--all");

// Порог возраста в днях (по умолчанию 7). Можно переопределить --days=N.
const daysArg = process.argv.find((a) => a.startsWith("--days="));
const DAYS = daysArg ? Number(daysArg.split("=")[1]) || 7 : 7;

// Статусы, считающиеся «незавершёнными/застрявшими».
const STUCK_STATUSES = ["pending_reply", "checking_reply", "scheduled"];

async function main() {
  const total = await prisma.automationDelivery.count();
  console.log(`Всего AutomationDelivery в базе: ${total}`);
  console.log(`Целевые статусы: ${STUCK_STATUSES.join(", ")}`);
  console.log(ALL ? "Возрастной порог: ИГНОРИРУЕТСЯ (--all)" : `Возрастной порог: старше ${DAYS} дн.`);

  // Берём кандидатов по статусу.
  const candidates = await prisma.automationDelivery.findMany({
    where: { status: { in: STUCK_STATUSES } },
    select: { id: true, fanId: true, status: true, sentAt: true, createdAt: true, messageId: true },
  });
  console.log(`Записей в целевых статусах: ${candidates.length}`);

  const cutoff = Date.now() - DAYS * 24 * 60 * 60 * 1000;

  const toDelete = [];
  for (const r of candidates) {
    if (ALL) {
      toDelete.push(r);
      continue;
    }
    const ageRef = r.sentAt || r.createdAt;
    const t = ageRef ? new Date(ageRef).getTime() : 0;
    if (t && t < cutoff) toDelete.push(r);
  }

  console.log("------------------------------------------------------------");
  console.log(`К удалению (застрявшие и старые): ${toDelete.length}`);
  // Короткий предпросмотр что именно удаляем.
  toDelete.slice(0, 30).forEach((r) => {
    console.log(`  fan=${r.fanId} status=${r.status} sentAt=${r.sentAt || "—"} msg=${r.messageId || "—"}`);
  });
  if (toDelete.length > 30) console.log(`  ...и ещё ${toDelete.length - 30}`);
  console.log("------------------------------------------------------------");

  if (!toDelete.length) {
    console.log("Нечего удалять.");
    return;
  }

  if (!APPLY) {
    console.log("DRY-RUN: ничего не удалено. Запусти с --apply чтобы реально почистить.");
    return;
  }

  const ids = toDelete.map((r) => r.id);
  let deleted = 0;
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const res = await prisma.automationDelivery.deleteMany({ where: { id: { in: chunk } } });
    deleted += res.count;
    console.log(`удалено ${deleted}/${ids.length}...`);
  }

  const after = await prisma.automationDelivery.count();
  console.log("------------------------------------------------------------");
  console.log(`ГОТОВО. Удалено застрявших: ${deleted}. Теперь в базе: ${after}`);
}

main()
  .catch((e) => {
    console.error("ОШИБКА:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch (_) {}
  });
