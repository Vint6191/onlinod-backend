"use strict";

/**
 * Одноразовая чистка дублей AutomationDelivery.
 *
 * Причина дублей: старый upsert-роут вставлял новую строку на каждый sweep-тик,
 * когда у записи не было серверного id. Накопились тысячи клонов одних и тех же
 * майских бампов (одинаковый creatorId+messageId).
 *
 * Логика: для каждой группы (creatorId, messageId) с messageId != null
 * оставляем ОДНУ строку (самую свежую по updatedAt), остальные удаляем.
 * Записи без messageId не трогаем.
 *
 * Запуск:
 *   node dedupe-deliveries.js          -> DRY-RUN (только покажет, ничего не удалит)
 *   node dedupe-deliveries.js --apply  -> реально удалит дубли
 *
 * Положить рядом с бэкендом (где доступен ../src/prisma) или подправить путь require ниже.
 */

const path = require("path");

// Подхватываем тот же prisma-клиент, что и бэкенд.
let prisma;
try {
  prisma = require("../src/prisma");
} catch (e1) {
  try {
    prisma = require("./src/prisma");
  } catch (e2) {
    const { PrismaClient } = require("@prisma/client");
    prisma = new PrismaClient();
  }
}

const APPLY = process.argv.includes("--apply");

async function main() {
  const total = await prisma.automationDelivery.count();
  console.log(`Всего AutomationDelivery в базе: ${total}`);

  // Берём все строки с messageId, только нужные поля (легко влезет в память даже на тысячах).
  const rows = await prisma.automationDelivery.findMany({
    where: { messageId: { not: null } },
    select: { id: true, creatorId: true, messageId: true, updatedAt: true },
    orderBy: { updatedAt: "desc" }, // самые свежие первыми
  });
  console.log(`Строк с messageId: ${rows.length}`);

  // Группируем по creatorId|messageId. Первая (самая свежая) — keeper, остальные — на удаление.
  const seen = new Set();
  const toDelete = [];
  let groups = 0;
  for (const r of rows) {
    const key = `${r.creatorId}||${r.messageId}`;
    if (seen.has(key)) {
      toDelete.push(r.id);
    } else {
      seen.add(key);
      groups++;
    }
  }

  const withoutMessageId = await prisma.automationDelivery.count({
    where: { messageId: null },
  });

  console.log("------------------------------------------------------------");
  console.log(`Уникальных бампов (creatorId+messageId): ${groups}`);
  console.log(`Записей без messageId (не трогаем):       ${withoutMessageId}`);
  console.log(`ДУБЛЕЙ к удалению:                        ${toDelete.length}`);
  console.log(`Останется после чистки:                   ${groups + withoutMessageId}`);
  console.log("------------------------------------------------------------");

  if (!toDelete.length) {
    console.log("Дублей нет. Чистить нечего.");
    return;
  }

  if (!APPLY) {
    console.log("DRY-RUN: ничего не удалено. Запусти с --apply чтобы реально почистить.");
    return;
  }

  // Удаляем пачками по 500, чтобы не упереться в лимиты.
  let deleted = 0;
  const CHUNK = 500;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const chunk = toDelete.slice(i, i + CHUNK);
    const res = await prisma.automationDelivery.deleteMany({
      where: { id: { in: chunk } },
    });
    deleted += res.count;
    console.log(`удалено ${deleted}/${toDelete.length}...`);
  }

  const after = await prisma.automationDelivery.count();
  console.log("------------------------------------------------------------");
  console.log(`ГОТОВО. Удалено дублей: ${deleted}. Теперь в базе: ${after}`);
}

main()
  .catch((e) => {
    console.error("ОШИБКА:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await prisma.$disconnect(); } catch (_) {}
  });
