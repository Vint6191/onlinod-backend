"use strict";
const c = require("./common");
const { emptyStats } = require("./dialog-repository");
const LIMIT = 100,
  BYTES = 262144;
const iso = (value) => (value ? c.iso(value) : null);
function mediaRow(r) {
  return {
    dialog_id: r.dialog_id,
    message_id: r.message_id,
    media_ids_json: JSON.stringify(r.data.mediaIds),
    price: Number(r.price_cents) / 100,
    opened: r.provider_opened || r.canonical_opened ? 1 : 0,
    created_at: c.iso(r.created_at),
    updated_at: r.data.updatedAt || c.iso(r.first_seen_at),
    purchase_evidence: r.provider_opened ? "PROVIDER" : r.canonical_opened ? "CANONICAL" : "NONE",
  };
}
function emptyCrmStats() {
  return {
    ...emptyStats(),
    purchasedMessagesCount: 0,
    purchasedPrice: 0,
    offeredPrice: 0,
    averagePurchase: 0,
    maxPurchase: 0,
    oldestMessageAt: null,
    newestMessageAt: null,
    lastScanAt: null,
    fullScanDone: false,
    scanHasMore: false,
    scanPagesDone: 0,
  };
}
class DialogReadModels {
  constructor(dialogs) {
    this.dialogs = dialogs;
    this.db = dialogs.db;
  }
  async panel(ctx, input) {
    const row = await c.one(
      this.db,
      `SELECT s.epoch,s.collection_from,s.quota_bytes,s.used_bytes,s.status,t.state,t.stats,t.revision,t.rewrite_revision,t.upper_at,t.upper_id,
      coalesce((SELECT jsonb_agg(m.data ORDER BY m.created_at DESC,length(m.message_id) DESC,m.message_id DESC) FROM
        (SELECT data,created_at,message_id FROM dialog_archive_message WHERE scope_id=s.scope_id AND dialog_id=$2 ORDER BY created_at DESC,length(message_id) DESC,message_id DESC LIMIT $3) m),'[]'::jsonb) recent
      FROM dialog_archive_scope s LEFT JOIN dialog_archive_thread t ON t.scope_id=s.scope_id AND t.dialog_id=$2 WHERE s.scope_id=$1`,
      ctx.scopeId,
      input.dialogId,
      Math.min(40, c.integer(input.recentLimit, 20, 40))
    );
    const stats = {
      ...emptyCrmStats(),
      ...row?.stats,
      totalPrice: 0,
      purchasedPrice: 0,
      averagePurchase: 0,
      maxPurchase: 0,
      purchasedMessagesCount: Number(row?.stats?.purchasedMessagesCount || 0),
      offeredPrice: Number(row?.stats?.totalPrice || 0),
      newestMessageAt: iso(row?.upper_at),
      lastScanAt: row?.state?.lastScanAt || null,
      scanHasMore: row?.state?.scanHasMore === true,
      scanPagesDone: row?.state?.scanPagesDone || 0,
    };
    const recentMessages = row?.recent || [];
    c.bounded(recentMessages, 1048576);
    return {
      stats,
      recentMessages,
      history: {
        available: true,
        error: null,
        collectionFromAt: iso(row?.collection_from),
        complete: row?.state?.collectionComplete === true,
        revision: Number(row?.revision || 0),
        usedBytes: Number(row?.used_bytes || 0),
        limitBytes: Number(row?.quota_bytes || 200000000),
        status: row?.status || "NOT_STARTED",
      },
      currentInput: row ? { epoch: row.epoch, revision: Number(row.revision || 0) } : null,
    };
  }
  async getThreadRow(ctx, input) {
    const r = await c.one(
      this.db,
      "SELECT * FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id=$2",
      ctx.scopeId,
      c.platformId(input.dialogId)
    );
    if (!r) return null;
    return {
      creator_id: ctx.creatorId,
      dialog_id: r.dialog_id,
      fan_id: r.platform_fan_id,
      ...Object.fromEntries(
        Object.entries(r.stats).map(([k, v]) => [k.replace(/[A-Z]/g, (l) => "_" + l.toLowerCase()), v])
      ),
      oldest_message_at: r.stats.oldestMessageAt || null,
      newest_message_at: iso(r.upper_at),
      newest_message_id: r.upper_id,
      updated_at: iso(r.updated_at),
      full_scan_done: 0,
      collection_complete: r.state.collectionComplete ? 1 : 0,
      scan_has_more: r.state.scanHasMore ? 1 : 0,
      scan_pages_done: r.state.scanPagesDone || 0,
      last_scan_at: r.state.lastScanAt || null,
    };
  }
  async buildCrmStats(ctx, input) {
    const t = await c.one(
      this.db,
      "SELECT * FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id=$2",
      ctx.scopeId,
      c.platformId(input.dialogId)
    );
    if (!t) return emptyCrmStats();
    return {
      ...emptyCrmStats(),
      ...t.stats,
      totalPrice: 0,
      purchasedPrice: 0,
      averagePurchase: 0,
      maxPurchase: 0,
      purchasedMessagesCount: Number(t.stats.purchasedMessagesCount || 0),
      offeredPrice: Number(t.stats.totalPrice || 0),
      newestMessageAt: iso(t.upper_at),
      lastScanAt: t.state.lastScanAt || null,
      scanHasMore: t.state.scanHasMore === true,
      scanPagesDone: t.state.scanPagesDone || 0,
      collectionComplete: t.state.collectionComplete === true,
    };
  }
  async listDirtyRuntimeMessageCountRows(ctx, input) {
    c.check(Array.isArray(input.dialogIds) && input.dialogIds.length <= 500, "DIALOG_LOOKUP_TOO_LARGE", 400);
    return c.rows(
      this.db,
      "SELECT ids.dialog_id,coalesce((t.stats->>'messagesCount')::bigint,0) messages,t.upper_id newest_message_id,t.upper_at newest_message_at FROM unnest($2::text[]) ids(dialog_id) LEFT JOIN dialog_archive_thread t ON t.scope_id=$1 AND t.dialog_id=ids.dialog_id ORDER BY ids.dialog_id",
      ctx.scopeId,
      input.dialogIds
    );
  }
  async version(ctx, input) {
    c.check(
      Array.isArray(input.dialogIds) && input.dialogIds.length > 0 && input.dialogIds.length <= 100,
      "MEDIA_USAGE_SCOPE_INVALID",
      400
    );
    const scope = await this.dialogs.scope(ctx);
    const stateRows = await c.rows(
      this.db,
      `SELECT ids.dialog_id,t.revision,t.updated_at,0 full_scan_done,CASE WHEN t.state->>'scanHasMore'='true' THEN 1 ELSE 0 END scan_has_more,t.state->>'scanError' scan_error,
      (t.stats->>'messagesCount')::bigint messages_count,t.stats->>'oldestMessageAt' oldest_message_at,t.upper_at newest_message_at,t.updated_at thread_updated_at FROM unnest($2::text[]) ids(dialog_id)
      LEFT JOIN dialog_archive_thread t ON t.scope_id=$1 AND t.dialog_id=ids.dialog_id ORDER BY ids.dialog_id`,
      ctx.scopeId,
      input.dialogIds
    );
    return { revision: c.hash([scope.epoch, stateRows]), stateRows: c.jsonResult(stateRows) };
  }
  async assertMediaUsageRevision(ctx, input) {
    c.check((await this.version(ctx, input)).revision === input.revision, "MEDIA_USAGE_INPUT_CONFLICT");
  }
  async listMediaUsageRows(ctx, input) {
    const version = await this.version(ctx, input);
    if (input.revision) c.check(version.revision === input.revision, "MEDIA_USAGE_INPUT_CONFLICT");
    // Sizes are read before bodies; neither a large archive nor a corrupt row can make this fetch unbounded.
    const meta = await c.rows(
      this.db,
      `SELECT dialog_id,message_id,octet_length((data->'mediaIds')::text)+1024 bytes FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=ANY($2::text[]) AND sender='creator'
      AND data->'mediaIds'<>'[]'::jsonb AND (dialog_id,message_id)>($3,$4) ORDER BY dialog_id,message_id LIMIT $5`,
      ctx.scopeId,
      input.dialogIds,
      input.after?.dialogId || "",
      input.after?.messageId || "",
      LIMIT + 1
    );
    const keys = [];
    let bytes = 2;
    for (const row of meta.slice(0, LIMIT)) {
      if (bytes + row.bytes > BYTES) {
        c.check(keys.length, "MEDIA_USAGE_ROW_TOO_LARGE", 413);
        break;
      }
      bytes += row.bytes;
      keys.push([row.dialog_id, row.message_id]);
    }
    const rows = keys.length
      ? await c.rows(
          this.db,
          `SELECT m.dialog_id,m.message_id,m.price_cents,m.provider_opened,m.canonical_opened,m.created_at,m.first_seen_at,jsonb_build_object('mediaIds',m.data->'mediaIds','updatedAt',m.data->'updatedAt') data FROM dialog_archive_message m JOIN jsonb_to_recordset($2::jsonb) x(dialog_id text,message_id text) USING(dialog_id,message_id) WHERE m.scope_id=$1 ORDER BY m.dialog_id,m.message_id`,
          ctx.scopeId,
          JSON.stringify(keys.map(([dialog_id, message_id]) => ({ dialog_id, message_id })))
        )
      : [];
    await this.assertMediaUsageRevision(ctx, { ...input, revision: version.revision });
    const last = keys.at(-1);
    return {
      ...version,
      messageRows: rows.map(mediaRow),
      next: last ? { dialogId: last[0], messageId: last[1] } : input.after || null,
      done: meta.length === keys.length,
    };
  }
  async listMediaUsageDialogIds(ctx, input) {
    return (
      await c.rows(
        this.db,
        "SELECT dialog_id FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id>$2 AND (stats->>'mediaCount')::bigint>0 ORDER BY dialog_id LIMIT 100",
        ctx.scopeId,
        input.afterDialogId || ""
      )
    ).map((r) => r.dialog_id);
  }
  async listMediaUsageFactPage(ctx, input) {
    const page = await this.listMediaUsageRows(ctx, {
      dialogIds: [input.dialogId],
      after: input.after ? { dialogId: input.dialogId, messageId: input.after.messageId } : null,
      revision: input.revision,
    });
    if (input.after) {
      const prior = await c.one(
        this.db,
        "SELECT * FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 AND message_id=$3 AND sender='creator'",
        ctx.scopeId,
        input.dialogId,
        input.after.messageId
      );
      if (prior) page.messageRows.unshift(mediaRow(prior));
    }
    const state = page.stateRows[0],
      capturedAt = state?.updated_at ? c.iso(state.updated_at) : new Date(0).toISOString();
    const coverage = {
      version: 1,
      complete: false,
      localRevision: page.revision,
      messageCount: Number(state?.messages_count || 0),
      oldestMessageAt: state?.oldest_message_at || null,
      newestMessageAt: state?.newest_message_at || null,
    };
    const facts = [];
    let next = input.after || null;
    for (const row of page.messageRows) {
      const ids = JSON.parse(row.media_ids_json).sort(),
        price = Math.round(row.price * 100),
        purchased = row.opened === 1 && price > 0;
      for (let index = 0; index < ids.length; index++) {
        const mediaId = ids[index];
        if (input.after && row.message_id === input.after.messageId && mediaId <= input.after.mediaId) continue;
        if (facts.length >= 1000) {
          await this.assertMediaUsageRevision(ctx, { dialogIds: [input.dialogId], revision: page.revision });
          return { facts, coverage, revision: page.revision, capturedAt, next, done: false };
        }
        facts.push({
          messageId: row.message_id,
          mediaId,
          allocationCount: ids.length,
          allocationIndex: index,
          purchaseEvidence: purchased ? row.purchase_evidence : "NONE",
          sentCount: 1,
          soldCount: purchased ? 1 : 0,
          notOpenedCount: price > 0 && !purchased ? 1 : 0,
          freeCount: price <= 0 ? 1 : 0,
          revenueCents: purchased ? Math.floor(price / ids.length) + (index < price % ids.length ? 1 : 0) : 0,
          uniqueBuyers: purchased ? 1 : 0,
          lastSoldAt: purchased ? row.created_at : null,
        });
        next = { messageId: row.message_id, mediaId };
      }
    }
    await this.assertMediaUsageRevision(ctx, { dialogIds: [input.dialogId], revision: page.revision });
    return { facts, coverage, revision: page.revision, capturedAt, next, done: page.done };
  }
  async listDialogMediaFacts(ctx, input) {
    const rows = await c.rows(
      this.db,
      "SELECT message_id,data->'mediaIds' media_ids,price_cents,provider_opened OR canonical_opened opened,created_at,data->>'updatedAt' updated_at FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 AND sender='creator' AND data->'mediaIds'<>'[]'::jsonb AND message_id>$3 ORDER BY message_id LIMIT 101",
      ctx.scopeId,
      input.dialogId,
      input.afterMessageId || ""
    );
    const more = rows.length > 100;
    rows.length = Math.min(rows.length, 100);
    return {
      items: rows.map((r) => ({
        messageId: r.message_id,
        mediaIds: r.media_ids,
        priceCents: Number(r.price_cents),
        purchased: r.opened,
        createdAt: c.iso(r.created_at),
        updatedAt: r.updated_at || c.iso(r.created_at),
      })),
      next: more ? rows.at(-1).message_id : null,
    };
  }
  async listVaultSalesRows(ctx, input) {
    const params = [ctx.scopeId],
      where = ["scope_id=$1", "sender='creator'", "data->'mediaIds'<>'[]'::jsonb"];
    const add = (sql, value) => {
      params.push(value);
      where.push(sql.replace("?", `$${params.length}`));
    };
    if (input.status)
      add(
        "(CASE WHEN price_cents<=0 THEN 'FREE' WHEN provider_opened OR canonical_opened THEN 'SOLD' ELSE 'NOT_OPENED' END)=?",
        input.status
      );
    if (input.buyerId) add("dialog_id=?", c.platformId(input.buyerId));
    if (input.assetId) add("(data->'mediaIds') @> ?::jsonb", JSON.stringify([c.platformId(input.assetId)]));
    if (input.from) add("created_at>=?::timestamptz", c.iso(input.from));
    if (input.to) add("created_at<=?::timestamptz", c.iso(input.to));
    const offset = c.integer(input.offset, 0, 10000),
      limit = Math.min(200, c.integer(input.limit, 100, 1000));
    const count = Number(
      (await c.one(this.db, `SELECT count(*) n FROM dialog_archive_message WHERE ${where.join(" AND ")}`, ...params)).n
    );
    const rows = await c.rows(
      this.db,
      `SELECT dialog_id,message_id,price_cents,provider_opened,canonical_opened,created_at,first_seen_at,jsonb_build_object('mediaIds',data->'mediaIds','updatedAt',data->'updatedAt') data FROM dialog_archive_message WHERE ${where.join(" AND ")} ORDER BY created_at DESC,message_id DESC,dialog_id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      ...params,
      limit,
      offset
    );
    const result = {
      rows: rows.map(mediaRow),
      count,
      offset,
      nextOffset: offset + rows.length,
      hasMore: offset + rows.length < count,
    };
    c.bounded(result, 1048576);
    return result;
  }
  async getDailyMessageMetricsRows(ctx, input) {
    c.check(
      /^\d{4}-\d\d-\d\d$/.test(input.startDate) &&
        /^\d{4}-\d\d-\d\d$/.test(input.endDate) &&
        input.startDate <= input.endDate,
      "DIALOG_RANGE_INVALID",
      400
    );
    c.check(Date.parse(input.endDate) - Date.parse(input.startDate) <= 366 * 86400000, "DIALOG_RANGE_TOO_LARGE", 400);
    const projection = `sum(incoming) incoming_messages,sum(outgoing) outgoing_messages,sum(incoming+outgoing) total_messages,count(DISTINCT dialog_id) FILTER(WHERE incoming+outgoing>0) unique_dialogs,
      count(DISTINCT dialog_id) FILTER(WHERE incoming>0) unique_incoming_fans,count(DISTINCT dialog_id) FILTER(WHERE outgoing>0) unique_outgoing_fans,sum(ppv_sent) ppv_sent,sum(ppv_opened) ppv_purchased,sum(purchased_cents)::float8/100 ppv_purchased_gross`;
    const rows = await c.rows(
      this.db,
      `SELECT to_char(day,'YYYY-MM-DD') date,${projection} FROM dialog_archive_day WHERE scope_id=$1 AND day BETWEEN $2::date AND $3::date GROUP BY day ORDER BY day`,
      ctx.scopeId,
      input.startDate,
      input.endDate
    );
    const totalRows = await c.rows(
      this.db,
      `SELECT ${projection} FROM dialog_archive_day WHERE scope_id=$1 AND day BETWEEN $2::date AND $3::date`,
      ctx.scopeId,
      input.startDate,
      input.endDate
    );
    const coverageRows = await c.rows(
      this.db,
      "SELECT count(*) known_dialogs,count(*) incomplete_dialogs FROM dialog_archive_thread WHERE scope_id=$1",
      ctx.scopeId
    );
    const storageRows = await c.rows(
      this.db,
      "SELECT sum((stats->>'messagesCount')::bigint) messages_indexed,min(stats->>'oldestMessageAt') oldest_message_at,max(upper_at) newest_message_at FROM dialog_archive_thread WHERE scope_id=$1",
      ctx.scopeId
    );
    return c.jsonResult({ rows, totalRows, coverageRows, storageRows });
  }
  async listUserMessageMetadataFirstSeenSince(ctx, input) {
    return (
      await c.rows(
        this.db,
        "SELECT message_id,created_at,first_seen_at FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 AND sender='user' AND first_seen_at>=$3::timestamptz AND ($4::timestamptz IS NULL OR (first_seen_at,message_id)>($4::timestamptz,$5)) ORDER BY first_seen_at,message_id LIMIT $6",
        ctx.scopeId,
        input.dialogId,
        c.iso(input.firstSeenAt),
        input.afterFirstSeenAt || null,
        input.afterMessageId || "",
        Math.min(500, input.limit || 100)
      )
    ).map((r) => ({ messageId: r.message_id, createdAt: c.iso(r.created_at), firstSeenAt: c.iso(r.first_seen_at) }));
  }
  async listTeamPendingBootstrapDialogs(ctx, input) {
    // A new collection window is not proof of the old full history. Bootstrap
    // only tails with a collected creator reply anchoring all following fan messages.
    const rows = await c.rows(
      this.db,
      `SELECT dialog_id,state FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id>$2 AND state->>'collectionComplete'='true' AND coalesce(state->>'scanHasMore','false')='false' AND ($3::text[] IS NULL OR dialog_id=ANY($3::text[])) AND EXISTS(SELECT 1 FROM dialog_archive_message m WHERE m.scope_id=dialog_archive_thread.scope_id AND m.dialog_id=dialog_archive_thread.dialog_id AND m.sender='creator') ORDER BY dialog_id LIMIT $4`,
      ctx.scopeId,
      input.afterDialogId || "",
      input.dialogIds || null,
      Math.min(100, input.limit || 50)
    );
    const result = [];
    for (const row of rows) {
      const last = await c.one(
        this.db,
        "SELECT created_at,message_id FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 AND sender='creator' ORDER BY created_at DESC,length(message_id) DESC,message_id DESC LIMIT 1",
        ctx.scopeId,
        row.dialog_id
      );
      if (!last) continue;
      const tail = await c.rows(
        this.db,
        "SELECT message_id,created_at FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 AND sender='user' AND (created_at,length(message_id),message_id)>($3::timestamptz,length($4::text),$4) AND ($5::timestamptz IS NULL OR created_at>=$5::timestamptz) ORDER BY created_at,length(message_id),message_id LIMIT 501",
        ctx.scopeId,
        row.dialog_id,
        last.created_at,
        last.message_id,
        input.minCreatedAt || null
      );
      c.check(tail.length <= 500, "TEAM_DIALOG_TAIL_TOO_LARGE", 413);
      result.push({
        dialogId: row.dialog_id,
        fanId: row.dialog_id,
        fullScanDone: false,
        tailComplete: true,
        messages: tail.map((m) => ({ messageId: m.message_id, createdAt: c.iso(m.created_at) })),
      });
    }
    return result;
  }
}
module.exports = { DialogReadModels, emptyCrmStats };
