"use strict";


const DEFAULT_PAGE_SIZE = 250;
const ACCOUNT_BATCH_SIZE = 250;

function clean(value, max = 180) {
  const text = String(value == null ? "" : value).trim();
  return text ? text.slice(0, max) : "";
}

function unique(values) {
  return Array.from(new Set((values || []).map((value) => clean(value)).filter(Boolean)));
}

function chunks(values, size = ACCOUNT_BATCH_SIZE) {
  const rows = [];
  for (let index = 0; index < values.length; index += size) rows.push(values.slice(index, index + size));
  return rows;
}

async function scanAllById({ delegate, where, select, pageSize = DEFAULT_PAGE_SIZE, onPage }) {
  if (!delegate?.findMany) return;
  let cursorId = null;
  for (;;) {
    const page = await delegate.findMany({
      where,
      select,
      orderBy: { id: "asc" },
      take: pageSize,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    });
    const rows = Array.isArray(page) ? page : [];
    if (!rows.length) return;
    const shouldStop = await onPage(rows);
    if (shouldStop === true) return;
    if (rows.length < pageSize) return;
    const nextCursor = clean(rows[rows.length - 1]?.id);
    if (!nextCursor || nextCursor === cursorId) {
      throw Object.assign(new Error("Exact authority pagination did not advance"), { code: "TELEGRAM_EXACT_AUTHORITY_SCAN_STALLED", status: 503 });
    }
    cursorId = nextCursor;
  }
}

async function scanActiveFollowupIntents({ agencyId, creatorIds, db, onRow }) {
  if (!db?.telegramDeliveryIntent?.findMany) return;
  const scopedCreatorIds = creatorIds == null ? null : unique(creatorIds);
  if (scopedCreatorIds && !scopedCreatorIds.length) return;
  await scanAllById({
    delegate: db.telegramDeliveryIntent,
    where: {
      agencyId,
      ...(scopedCreatorIds ? { creatorId: { in: scopedCreatorIds } } : {}),
      kind: { in: ["REFERENCE", "MANUAL_REMINDER", "AUTO_REMINDER", "CANCELLATION"] },
      state: { in: ["PLANNED", "CLAIMED", "COMMITTING", "RECONCILE_REQUIRED", "FAILED_PRECOMMIT"] },
    },
    select: { id: true, creatorId: true, accountId: true },
    onPage: async (rows) => {
      for (const row of rows) if (await onRow(row) === true) return true;
      return false;
    },
  });
}

async function fetchAccountRowsByIds({ agencyId, accountIds, db }) {
  const ids = unique(accountIds);
  if (!ids.length || !db?.agencyTelegramMtprotoAccount?.findMany) return [];
  const rows = [];
  for (const batch of chunks(ids)) {
    const found = await db.agencyTelegramMtprotoAccount.findMany({
      where: { agencyId, id: { in: batch } },
      select: { id: true, lifecycleState: true },
    });
    rows.push(...(found || []));
  }
  return rows;
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  scanAllById,
  scanActiveFollowupIntents,
  fetchAccountRowsByIds,
};
