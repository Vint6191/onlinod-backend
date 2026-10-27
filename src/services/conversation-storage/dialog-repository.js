"use strict";
const c = require("./common");
const THREAD_BYTES = 16384,
  MESSAGE_OVERHEAD = 1536,
  RECEIPT_BYTES = 4096,
  MAX_PAGE_BYTES = 524288;
const STATE_FIELDS = new Set([
  "fullScanDone",
  "newestMessageId",
  "newestMessageAt",
  "lastScanAt",
  "scanError",
  "scanCursorId",
  "scanMode",
  "scanHasMore",
  "scanPagesDone",
  "scanStartedAt",
  "scanPausedAt",
  "collectionComplete",
]);
const isoOrNull = (v) => (v ? c.iso(v) : null);
function emptyStats() {
  return {
    messagesCount: 0,
    creatorMessagesCount: 0,
    userMessagesCount: 0,
    mediaMessagesCount: 0,
    mediaCount: 0,
    paidMessagesCount: 0,
    openedCount: 0,
    purchasedMessagesCount: 0,
    totalPrice: 0,
  };
}
function contribution(m) {
  if (!m) return emptyStats();
  return {
    messagesCount: 1,
    creatorMessagesCount: m.sender === "creator" ? 1 : 0,
    userMessagesCount: m.sender === "user" ? 1 : 0,
    mediaMessagesCount: m.mediaIds.length ? 1 : 0,
    mediaCount: m.mediaIds.length,
    paidMessagesCount: m.price > 0 ? 1 : 0,
    openedCount: m.opened ? 1 : 0,
    purchasedMessagesCount: m.sender === "creator" && m.price > 0 && m.opened ? 1 : 0,
    totalPrice: m.price,
  };
}
function comparable(m) {
  return {
    platformCreatorId: m.platformCreatorId,
    platformFanId: m.platformFanId,
    platformAuthorId: m.platformAuthorId,
    sender: m.sender,
    text: m.text,
    mediaIds: m.mediaIds,
    price: m.price,
    createdAt: m.createdAt,
    changedAt: m.changedAt,
  };
}
function normalize(ctx, dialogId, raw) {
  c.check(
    raw && raw.creatorId === ctx.creatorId && String(raw.dialogId) === dialogId,
    "DIALOG_MESSAGE_SCOPE_MISMATCH",
    403
  );
  const messageId = c.platformId(raw.messageId),
    fanId = c.platformId(raw.platformFanId || dialogId);
  c.check(fanId === dialogId, "DIALOG_FAN_IDENTITY_MISMATCH", 400);
  c.check(
    !raw.platformCreatorId || raw.platformCreatorId === ctx.platformCreatorId,
    "DIALOG_CREATOR_IDENTITY_MISMATCH",
    403
  );
  c.check(raw.sender === "creator" || raw.sender === "user", "DIALOG_AUTHOR_REQUIRED", 400);
  const author = c.platformId(raw.platformAuthorId || (raw.sender === "creator" ? ctx.platformCreatorId : fanId));
  c.check(
    author === (raw.sender === "creator" ? ctx.platformCreatorId : fanId),
    "DIALOG_AUTHOR_IDENTITY_MISMATCH",
    400
  );
  c.check(typeof raw.text === "string" && Buffer.byteLength(raw.text) <= 65536, "DIALOG_MESSAGE_TOO_LARGE", 413);
  c.check(Array.isArray(raw.mediaIds) && raw.mediaIds.length <= 100, "DIALOG_MEDIA_INVALID", 400);
  const cents = Math.round(Number(raw.price) * 100);
  c.check(Number.isSafeInteger(cents) && cents >= 0, "DIALOG_PRICE_INVALID", 400);
  const m = {
    messageId,
    platformCreatorId: ctx.platformCreatorId,
    platformFanId: fanId,
    platformAuthorId: author,
    sender: raw.sender,
    text: raw.text,
    mediaIds: [...new Set(raw.mediaIds.map(c.platformId))],
    price: cents / 100,
    opened: raw.opened === 1 ? 1 : 0,
    createdAt: c.iso(raw.createdAt),
    changedAt: raw.changedAt ? c.iso(raw.changedAt) : null,
    source: raw.source === "delta_scan" ? "delta_scan" : "full_scan",
  };
  c.bounded(m, 98304);
  return m;
}
function publicRecord(ctx, dialogId, row) {
  return {
    ...row.data,
    id: `${ctx.creatorId}:${dialogId}:${row.message_id}`,
    creatorId: ctx.creatorId,
    dialogId,
    opened: row.provider_opened || row.canonical_opened ? 1 : 0,
    firstSeenAt: c.iso(row.first_seen_at),
    updatedAt: row.data.updatedAt || c.iso(row.first_seen_at),
  };
}
class DialogRepository {
  constructor(db) {
    this.db = db;
  }
  async scope(ctx, db = this.db) {
    let row = await c.one(
      db,
      "SELECT * FROM dialog_archive_scope WHERE scope_id=$1 AND agency_id=$2",
      ctx.scopeId,
      ctx.agencyId
    );
    if (!row) {
      await c.exec(
        db,
        `INSERT INTO dialog_archive_scope(scope_id,agency_id,platform,platform_creator_id,epoch) VALUES($1,$2,'onlyfans',$3,$4) ON CONFLICT DO NOTHING`,
        ctx.scopeId,
        ctx.agencyId,
        ctx.platformCreatorId,
        c.randomUUID()
      );
      row = await c.one(
        db,
        "SELECT * FROM dialog_archive_scope WHERE scope_id=$1 AND agency_id=$2",
        ctx.scopeId,
        ctx.agencyId
      );
    }
    c.check(row && row.platform_creator_id === ctx.platformCreatorId, "DIALOG_SCOPE_INVALID", 403);
    if (ctx.expectedEpoch) c.check(ctx.expectedEpoch === row.epoch, "DIALOG_STORAGE_EPOCH_CHANGED");
    return row;
  }
  async thread(ctx, dialogId, db = this.db) {
    c.platformId(dialogId);
    let row = await c.one(
      db,
      "SELECT * FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id=$2",
      ctx.scopeId,
      dialogId
    );
    if (row) return row;
    const added = await c.rows(
      db,
      `INSERT INTO dialog_archive_thread(scope_id,dialog_id,platform_fan_id,stats) VALUES($1,$2,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING dialog_id`,
      ctx.scopeId,
      dialogId,
      JSON.stringify(emptyStats())
    );
    if (added.length) {
      const charged = await c.rows(
        db,
        `UPDATE dialog_archive_scope SET used_bytes=used_bytes+$2 WHERE scope_id=$1 AND used_bytes+$2<=quota_bytes RETURNING scope_id`,
        ctx.scopeId,
        THREAD_BYTES
      );
      c.check(charged.length, "DIALOG_STORAGE_LIMIT", 507);
    }
    return c.one(db, "SELECT * FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id=$2", ctx.scopeId, dialogId);
  }
  state(ctx, scope, thread) {
    return {
      id: `${ctx.creatorId}:${thread.dialog_id}`,
      creatorId: ctx.creatorId,
      dialogId: thread.dialog_id,
      fullScanDone: false,
      newestMessageId: thread.upper_id,
      newestMessageAt: thread.upper_at ? c.iso(thread.upper_at) : null,
      lastScanAt: null,
      scanError: null,
      scanCursorId: null,
      scanMode: null,
      scanHasMore: false,
      scanPagesDone: 0,
      scanPausedAt: null,
      ...thread.state,
      scanStartedAt: thread.collector_token || null,
      updatedAt: c.iso(thread.updated_at),
      collectionFromAt: c.iso(scope.collection_from),
      storageEpoch: scope.epoch,
      storageStatus: scope.status,
      storageUsedBytes: Number(scope.used_bytes),
      storageLimitBytes: Number(scope.quota_bytes),
    };
  }
  async getState(ctx, input) {
    return c.transaction(this.db, async (tx) => {
      const scope = await this.scope(ctx, tx);
      const dialogId = c.platformId(input.dialogId);
      const thread = (await c.one(
        tx,
        "SELECT * FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id=$2",
        ctx.scopeId,
        dialogId
      )) || { dialog_id: dialogId, upper_id: null, upper_at: null, state: {}, updated_at: scope.created_at };
      return this.state(ctx, scope, thread);
    });
  }
  async prune(ctx) {
    return c.transaction(this.db, async (tx) => {
      await c.one(tx, "SELECT scope_id FROM dialog_archive_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
      const receipts = await c.rows(
        tx,
        "DELETE FROM dialog_archive_receipt WHERE (scope_id,command_id) IN (SELECT scope_id,command_id FROM dialog_archive_receipt WHERE scope_id=$1 AND expires_at<now() ORDER BY expires_at LIMIT 64) RETURNING command_id",
        ctx.scopeId
      );
      const pages = await c.rows(
        tx,
        "DELETE FROM dialog_archive_page WHERE (scope_id,dialog_id,episode,cursor) IN (SELECT scope_id,dialog_id,episode,cursor FROM dialog_archive_page WHERE scope_id=$1 AND created_at<now()-interval '2 days' ORDER BY created_at LIMIT 64) RETURNING cursor",
        ctx.scopeId
      );
      const freed = (receipts.length + pages.length) * RECEIPT_BYTES;
      if (freed)
        await c.exec(
          tx,
          "UPDATE dialog_archive_scope SET used_bytes=GREATEST(0,used_bytes-$2),status=CASE WHEN used_bytes-$2<quota_bytes-16384 THEN 'ACTIVE' ELSE status END WHERE scope_id=$1",
          ctx.scopeId,
          freed
        );
    });
  }
  async getStatus(ctx) {
    await this.scope(ctx);
    await this.prune(ctx);
    const s = await this.scope(ctx);
    return {
      mode: "server",
      platformCreatorId: s.platform_creator_id,
      epoch: s.epoch,
      collectionFromAt: c.iso(s.collection_from),
      usedBytes: Number(s.used_bytes),
      limitBytes: Number(s.quota_bytes),
      status: s.status,
      inventoryComplete: s.inventory_complete,
    };
  }
  async lease(ctx, thread, patch, db, expectedEpisode) {
    // A lease timeout permits a new owner to acquire, never an old owner to
    // finish/error a newer episode. Fence terminal and paused writes as well.
    c.check(expectedEpisode === (thread.collector_token || null), "DIALOG_COLLECTOR_LEASE_LOST");
    const starting = Object.hasOwn(patch, "scanStartedAt");
    if (starting) {
      c.text(patch.scanStartedAt);
      c.check(["full", "delta"].includes(patch.scanMode), "DIALOG_SCAN_MODE_INVALID", 400);
      c.check(
        !thread.collector_until ||
          new Date(thread.collector_until).getTime() <= Date.now() ||
          thread.collector_device === ctx.deviceId,
        "DIALOG_COLLECTOR_BUSY",
        423
      );
    } else {
      c.check(thread.collector_token && thread.collector_device === ctx.deviceId, "DIALOG_COLLECTOR_LEASE_LOST");
    }
    const released = patch.scanHasMore === false || Boolean(patch.scanPausedAt) || Boolean(patch.scanError);
    await c.exec(
      db,
      `UPDATE dialog_archive_thread SET collector_device=$3,collector_token=$4,collector_until=CASE WHEN $5 THEN now() ELSE now()+interval '2 minutes' END WHERE scope_id=$1 AND dialog_id=$2`,
      ctx.scopeId,
      thread.dialog_id,
      ctx.deviceId,
      patch.scanStartedAt || thread.collector_token,
      released
    );
  }
  async markState(ctx, input) {
    return c.transaction(this.db, async (tx) => {
      await this.scope(ctx, tx);
      const scope = await c.one(tx, "SELECT * FROM dialog_archive_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
      c.check(input.storageEpoch === scope.epoch, "HISTORY_INPUT_CONFLICT");
      const thread = await this.thread(ctx, c.platformId(input.dialogId), tx);
      const patch = Object.fromEntries(Object.entries(c.object(input.patch)).filter(([k]) => STATE_FIELDS.has(k)));
      // Only a committed collection page can establish completeness or advance its durable cursor.
      delete patch.fullScanDone;
      delete patch.collectionComplete;
      delete patch.newestMessageId;
      delete patch.newestMessageAt;
      delete patch.scanCursorId;
      delete patch.scanPagesDone;
      c.bounded(patch, 2000);
      await this.lease(ctx, thread, patch, tx, input.expectedEpisode);
      if (patch.scanStartedAt && patch.scanStartedAt !== thread.state.scanStartedAt) {
        patch.scanCursorId = null;
        patch.scanPagesDone = 0;
      }
      const next = { ...thread.state, ...patch };
      await c.exec(
        tx,
        "UPDATE dialog_archive_thread SET state=$3::jsonb,updated_at=now() WHERE scope_id=$1 AND dialog_id=$2",
        ctx.scopeId,
        input.dialogId,
        JSON.stringify(next)
      );
      return this.state(ctx, scope, { ...thread, state: next, updated_at: new Date() });
    });
  }
  async commitScanPage(ctx, input, command, receiptInput = input) {
    const dialogId = c.platformId(input.dialogId);
    c.check(Array.isArray(input.messages) && input.messages.length <= 200, "DIALOG_BATCH_INVALID", 400);
    c.bounded(input, MAX_PAGE_BYTES);
    const normalized = input.messages.map((m) => normalize(ctx, dialogId, m)),
      requestHash = c.hash(receiptInput);
    if (command) c.commandId(command, { receiptReplay: true });
    try {
      return await c.transaction(this.db, async (tx) => {
        let scope = await this.scope(ctx, tx);
        scope = await c.one(tx, "SELECT * FROM dialog_archive_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
        if (command) {
          const old = await c.one(
            tx,
            "SELECT * FROM dialog_archive_receipt WHERE scope_id=$1 AND command_id=$2",
            ctx.scopeId,
            command
          );
          if (old) {
            c.check(old.request_hash === requestHash, "DIALOG_COMMAND_CONFLICT");
            return old.result;
          }
          // An old command may retrieve its receipt, but can never execute again
          // after receipt retention or an independent database restore.
          c.commandId(command);
        }
        let thread = await this.thread(ctx, dialogId, tx);
        const f = input.frontier;
        const expiredReceipts = await c.rows(
          tx,
          "DELETE FROM dialog_archive_receipt WHERE (scope_id,command_id) IN (SELECT scope_id,command_id FROM dialog_archive_receipt WHERE scope_id=$1 AND expires_at<now() ORDER BY expires_at LIMIT 32) RETURNING command_id",
          ctx.scopeId
        );
        const expiredPages = await c.rows(
          tx,
          "DELETE FROM dialog_archive_page WHERE (scope_id,dialog_id,episode,cursor) IN (SELECT scope_id,dialog_id,episode,cursor FROM dialog_archive_page WHERE scope_id=$1 AND created_at<now()-interval '2 days' ORDER BY created_at LIMIT 32) RETURNING cursor",
          ctx.scopeId
        );
        const reclaimed = (expiredReceipts.length + expiredPages.length) * RECEIPT_BYTES;
        if (reclaimed)
          await c.exec(
            tx,
            "UPDATE dialog_archive_scope SET used_bytes=GREATEST(0,used_bytes-$2) WHERE scope_id=$1",
            ctx.scopeId,
            reclaimed
          );
        if (f) {
          c.text(f.episode);
          if (f.storageEpoch) c.check(f.storageEpoch === scope.epoch, "HISTORY_INPUT_CONFLICT");
          c.check(
            !thread.collector_token ||
              (thread.collector_token === f.episode && thread.collector_device === ctx.deviceId),
            "DIALOG_COLLECTOR_LEASE_LOST",
            409
          );
          c.check(
            !thread.collector_until ||
              new Date(thread.collector_until).getTime() < Date.now() ||
              thread.collector_device === ctx.deviceId,
            "DIALOG_COLLECTOR_BUSY",
            423
          );
          const old = await c.one(
            tx,
            "SELECT * FROM dialog_archive_page WHERE scope_id=$1 AND dialog_id=$2 AND episode=$3 AND cursor=$4",
            ctx.scopeId,
            dialogId,
            f.episode,
            f.cursor || ""
          );
          if (old) {
            c.check(old.request_hash === requestHash, "DIALOG_PAGE_REPLAY_CONFLICT");
            return old.result;
          }
          c.check((f.cursor || null) === (thread.state.scanCursorId || null), "DIALOG_SCAN_FRONTIER_CHANGED");
          if (f.nextCursor) {
            const cycle = await c.one(
              tx,
              "SELECT 1 FROM dialog_archive_page WHERE scope_id=$1 AND dialog_id=$2 AND episode=$3 AND cursor=$4",
              ctx.scopeId,
              dialogId,
              f.episode,
              f.nextCursor
            );
            c.check(!cycle && f.nextCursor !== f.cursor, "DIALOG_CURSOR_STALLED");
          }
        }
        const summary = { inserted: 0, updated: 0, duplicates: 0 };
        let delta = ((command ? 1 : 0) + (f ? 1 : 0)) * RECEIPT_BYTES,
          stats = { ...emptyStats(), ...thread.stats },
          revision = Number(thread.revision),
          rewrite = Number(thread.rewrite_revision);
        let upper = thread.upper_at ? { at: c.iso(thread.upper_at), id: thread.upper_id } : null;
        const priorRows = normalized.length
          ? await c.rows(
              tx,
              "SELECT * FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 AND message_id=ANY($3::text[])",
              ctx.scopeId,
              dialogId,
              normalized.map((m) => m.messageId)
            )
          : [];
        const priorById = new Map(priorRows.map((row) => [row.message_id, row])),
          writes = [],
          days = new Map();
        c.check(
          new Set(normalized.map((m) => m.messageId)).size === normalized.length,
          "DIALOG_DUPLICATE_MESSAGE_IN_PAGE",
          400
        );
        for (const candidate of normalized) {
          const old = priorById.get(candidate.messageId);
          if (old && input.presentFields)
            for (const key of ["text", "mediaIds", "price", "createdAt"])
              if (!input.presentFields.includes(key)) candidate[key] = old.data[key];
          // The new server archive starts at activation; this is not an implicit local-history import.
          if (!old && new Date(candidate.createdAt) < new Date(scope.collection_from) && !input.targeted) {
            summary.duplicates++;
            continue;
          }
          const oldData = old ? publicRecord(ctx, dialogId, old) : null;
          const stale =
            old &&
            Date.parse(candidate.changedAt || candidate.createdAt) <
              Date.parse(old.data.changedAt || old.data.createdAt);
          const next = stale ? { ...old.data } : { ...candidate };
          if (old)
            c.check(
              next.createdAt === c.iso(old.created_at) && next.sender === old.sender,
              "DIALOG_IMMUTABLE_IDENTITY_CONFLICT"
            );
          let providerOpened = Boolean(old?.provider_opened || candidate.opened === 1),
            canonicalOpened = Boolean(old?.canonical_opened);
          let canonicalRevision = String(old?.canonical_revision || 0),
            providerObservedAt = old?.provider_observed_at ? c.iso(old.provider_observed_at) : null;
          const proof = input.purchaseProof;
          if (proof && proof.messageId === candidate.messageId) {
            if (proof.kind === "canonical" && BigInt(proof.revision) > BigInt(canonicalRevision)) {
              canonicalOpened = proof.opened === true;
              canonicalRevision = String(proof.revision);
            }
            if (proof.kind === "provider" && (!providerObservedAt || c.iso(proof.observedAt) > providerObservedAt)) {
              providerOpened = proof.opened === true;
              providerObservedAt = c.iso(proof.observedAt);
            }
          }
          next.opened = providerOpened || canonicalOpened ? 1 : 0;
          const fingerprint = c.hash(comparable(next));
          if (
            old &&
            old.content_hash === fingerprint &&
            old.provider_opened === providerOpened &&
            old.canonical_opened === canonicalOpened &&
            String(old.canonical_revision) === canonicalRevision &&
            (!providerObservedAt || providerObservedAt === isoOrNull(old.provider_observed_at))
          ) {
            summary.duplicates++;
            continue;
          }
          revision++;
          if (
            old ||
            (upper &&
              (next.createdAt < upper.at || (next.createdAt === upper.at && BigInt(next.messageId) < BigInt(upper.id))))
          )
            rewrite = revision;
          stats.oldestMessageAt =
            !stats.oldestMessageAt || next.createdAt < stats.oldestMessageAt ? next.createdAt : stats.oldestMessageAt;
          next.firstSeenAt = old ? c.iso(old.first_seen_at) : new Date().toISOString();
          next.updatedAt = new Date().toISOString();
          const bytes = Buffer.byteLength(JSON.stringify(next)) + MESSAGE_OVERHEAD;
          delta += bytes - Number(old?.storage_bytes || 0);
          const before = contribution(oldData),
            after = contribution(next);
          for (const key of Object.keys(emptyStats()))
            stats[key] = Math.max(0, Number(stats[key] || 0) + after[key] - before[key]);
          if (
            !upper ||
            next.createdAt > upper.at ||
            (next.createdAt === upper.at && BigInt(next.messageId) > BigInt(upper.id))
          )
            upper = { at: next.createdAt, id: next.messageId };
          writes.push({
            message_id: next.messageId,
            platform_creator_id: ctx.platformCreatorId,
            platform_fan_id: next.platformFanId,
            platform_author_id: next.platformAuthorId,
            created_at: next.createdAt,
            changed_at: next.changedAt,
            sender: next.sender,
            price_cents: Math.round(next.price * 100),
            provider_opened: providerOpened,
            canonical_opened: canonicalOpened,
            canonical_revision: canonicalRevision,
            provider_observed_at: providerObservedAt,
            data: next,
            content_hash: fingerprint,
            storage_bytes: bytes,
            revision,
          });
          for (const [value, sign] of [
            [oldData, -1],
            [next, 1],
          ])
            if (value) {
              const creator = value.sender === "creator",
                day = value.createdAt.slice(0, 10);
              const agg = days.get(day) || {
                day,
                incoming: 0,
                outgoing: 0,
                media: 0,
                ppv_sent: 0,
                ppv_opened: 0,
                offered_cents: 0,
                purchased_cents: 0,
              };
              agg.incoming += creator ? 0 : sign;
              agg.outgoing += creator ? sign : 0;
              agg.media += value.mediaIds.length * sign;
              agg.ppv_sent += creator && value.price > 0 ? sign : 0;
              agg.ppv_opened += creator && value.price > 0 && value.opened ? sign : 0;
              agg.offered_cents += creator ? Math.round(value.price * 100) * sign : 0;
              agg.purchased_cents +=
                creator && value.price > 0 && value.opened ? Math.round(value.price * 100) * sign : 0;
              days.set(day, agg);
            }
          if (old) summary.updated++;
          else summary.inserted++;
        }
        if (writes.length) {
          await c.exec(
            tx,
            `INSERT INTO dialog_archive_message(scope_id,dialog_id,message_id,platform_creator_id,platform_fan_id,platform_author_id,created_at,changed_at,sender,price_cents,provider_opened,canonical_opened,canonical_revision,provider_observed_at,data,content_hash,storage_bytes,revision)
        SELECT $1,$2,x.* FROM jsonb_to_recordset($3::jsonb) x(message_id text,platform_creator_id text,platform_fan_id text,platform_author_id text,created_at timestamptz,changed_at timestamptz,sender text,price_cents bigint,provider_opened boolean,canonical_opened boolean,canonical_revision bigint,provider_observed_at timestamptz,data jsonb,content_hash text,storage_bytes integer,revision bigint)
        ON CONFLICT(scope_id,dialog_id,message_id) DO UPDATE SET changed_at=EXCLUDED.changed_at,price_cents=EXCLUDED.price_cents,provider_opened=EXCLUDED.provider_opened,canonical_opened=EXCLUDED.canonical_opened,canonical_revision=EXCLUDED.canonical_revision,provider_observed_at=EXCLUDED.provider_observed_at,data=EXCLUDED.data,content_hash=EXCLUDED.content_hash,storage_bytes=EXCLUDED.storage_bytes,revision=EXCLUDED.revision`,
            ctx.scopeId,
            dialogId,
            JSON.stringify(writes)
          );
          await c.exec(
            tx,
            `INSERT INTO dialog_archive_day(scope_id,day,dialog_id,incoming,outgoing,media,ppv_sent,ppv_opened,offered_cents,purchased_cents)
          SELECT $1,x.day,$2,x.incoming,x.outgoing,x.media,x.ppv_sent,x.ppv_opened,x.offered_cents,x.purchased_cents
          FROM jsonb_to_recordset($3::jsonb) x(day date,incoming bigint,outgoing bigint,media bigint,ppv_sent bigint,ppv_opened bigint,offered_cents bigint,purchased_cents bigint)
          ON CONFLICT(scope_id,day,dialog_id) DO UPDATE SET incoming=dialog_archive_day.incoming+EXCLUDED.incoming,outgoing=dialog_archive_day.outgoing+EXCLUDED.outgoing,
          media=dialog_archive_day.media+EXCLUDED.media,ppv_sent=dialog_archive_day.ppv_sent+EXCLUDED.ppv_sent,ppv_opened=dialog_archive_day.ppv_opened+EXCLUDED.ppv_opened,
          offered_cents=dialog_archive_day.offered_cents+EXCLUDED.offered_cents,purchased_cents=dialog_archive_day.purchased_cents+EXCLUDED.purchased_cents`,
            ctx.scopeId,
            dialogId,
            JSON.stringify([...days.values()])
          );
        }
        const charged = await c.rows(
          tx,
          `UPDATE dialog_archive_scope SET used_bytes=used_bytes+$2,revision=revision+$3,status='ACTIVE',relay_pending=relay_pending OR $3>0 WHERE scope_id=$1 AND ($2<=0 OR used_bytes+$2<=quota_bytes) RETURNING *`,
          ctx.scopeId,
          delta,
          summary.inserted + summary.updated
        );
        c.check(charged.length, "DIALOG_STORAGE_LIMIT", 507);
        scope = charged[0];
        const patch = Object.fromEntries(
          Object.entries(c.object(input.statePatch)).filter(([k]) => STATE_FIELDS.has(k))
        );
        c.bounded(patch, 2000);
        c.check((!patch.fullScanDone && !patch.collectionComplete) || Boolean(f), "DIALOG_COMPLETENESS_PROOF_REQUIRED");
        const nextState = {
          ...thread.state,
          ...patch,
          newestMessageId: upper?.id || null,
          newestMessageAt: upper?.at || null,
        };
        if (f) {
          nextState.scanCursorId = nextState.scanHasMore ? f.nextCursor || null : null;
          nextState.scanPagesDone = Number(thread.state.scanPagesDone || 0) + 1;
        }
        if (scope.collection_from) {
          nextState.fullScanDone = false;
          if (patch.fullScanDone || patch.collectionComplete) nextState.collectionComplete = true;
        }
        await c.exec(
          tx,
          `UPDATE dialog_archive_thread SET revision=$3,rewrite_revision=$4,state=$5::jsonb,stats=$6::jsonb,upper_at=$7::timestamptz,upper_id=$8,updated_at=now(),
        collector_device=CASE WHEN $9 THEN $10 ELSE collector_device END,collector_token=CASE WHEN $9 THEN $11 ELSE collector_token END,collector_until=CASE WHEN $9 THEN CASE WHEN $12 THEN now()+interval '2 minutes' ELSE now() END ELSE collector_until END
        WHERE scope_id=$1 AND dialog_id=$2`,
          ctx.scopeId,
          dialogId,
          revision,
          rewrite,
          JSON.stringify(nextState),
          JSON.stringify(stats),
          upper?.at || null,
          upper?.id || null,
          Boolean(f),
          ctx.deviceId,
          f?.episode || null,
          nextState.scanHasMore === true
        );
        if (summary.inserted + summary.updated)
          await c.exec(
            tx,
            `INSERT INTO dialog_archive_outbox(scope_id,dialog_id,revision,rewrite_revision) VALUES($1,$2,$3,$4)
        ON CONFLICT(scope_id,dialog_id) DO UPDATE SET revision=EXCLUDED.revision,rewrite_revision=EXCLUDED.rewrite_revision,retry_at=now()`,
            ctx.scopeId,
            dialogId,
            revision,
            rewrite
          );
        const result = {
          summary,
          state: this.state(ctx, scope, { ...thread, state: nextState, updated_at: new Date() }),
        };
        c.bounded(result, RECEIPT_BYTES - 1024);
        if (writes.length)
          await c.exec(
            tx,
            `INSERT INTO dialog_archive_debt(scope_id,dialog_id,owner,desired) SELECT $1,$2,x,$3 FROM unnest(ARRAY['analysis','media','ui']) x ON CONFLICT(scope_id,dialog_id,owner) DO UPDATE SET desired=EXCLUDED.desired,status='WAITING',next_at=now(),attempts=0`,
            ctx.scopeId,
            dialogId,
            revision
          );
        if (f)
          await c.exec(
            tx,
            "INSERT INTO dialog_archive_page(scope_id,dialog_id,episode,cursor,next_cursor,known_page,result,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)",
            ctx.scopeId,
            dialogId,
            f.episode,
            f.cursor || "",
            f.nextCursor || "",
            f.knownPage,
            JSON.stringify(result),
            requestHash
          );
        if (command)
          await c.exec(
            tx,
            `INSERT INTO dialog_archive_receipt(scope_id,command_id,request_hash,result,expires_at) VALUES($1,$2,$3,$4::jsonb,now()+interval '2 days')`,
            ctx.scopeId,
            command,
            requestHash,
            JSON.stringify(result)
          );
        return result;
      });
    } catch (error) {
      if (error.code === "DIALOG_STORAGE_LIMIT")
        await c.exec(this.db, "UPDATE dialog_archive_scope SET status='QUOTA_REACHED' WHERE scope_id=$1", ctx.scopeId);
      throw error;
    }
  }
  async getMessages(ctx, input) {
    const order = input.order === "asc" ? "ASC" : "DESC";
    const limit = Math.min(200, c.integer(input.limit, 100, 1000));
    const offset = c.integer(input.offset, 0, 10000);
    const result = await c.rows(
      this.db,
      `SELECT * FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 ORDER BY created_at ${order},length(message_id) ${order},message_id ${order} LIMIT $3 OFFSET $4`,
      ctx.scopeId,
      c.platformId(input.dialogId),
      limit,
      offset
    );
    const out = result.map((row) => publicRecord(ctx, input.dialogId, row));
    c.bounded(out, 1048576);
    return out;
  }
  async findExistingMessageIds(ctx, input) {
    c.check(Array.isArray(input.messageIds) && input.messageIds.length <= 500, "DIALOG_LOOKUP_TOO_LARGE", 400);
    await this.scope(ctx);
    if (!input.messageIds.length) return [];
    const records = await c.rows(
      this.db,
      "SELECT * FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 AND message_id=ANY($3::text[]) AND ($4::timestamptz IS NULL OR first_seen_at<$4::timestamptz)",
      ctx.scopeId,
      input.dialogId,
      input.messageIds,
      input.knownBefore || null
    );
    const candidates = new Map(
      (input.unchangedMessages || []).map((m) => [m.messageId, normalize(ctx, input.dialogId, m)])
    );
    return records
      .filter(
        (row) =>
          !input.unchangedMessages ||
          (candidates.has(row.message_id) &&
            c.hash(comparable(candidates.get(row.message_id))) === row.content_hash &&
            Boolean(candidates.get(row.message_id).opened) === row.provider_opened)
      )
      .map((row) => row.message_id);
  }
  async inspectScanFrontier(ctx, input) {
    await this.scope(ctx);
    const latest = await c.one(
      this.db,
      "SELECT known_page FROM dialog_archive_page WHERE scope_id=$1 AND dialog_id=$2 AND episode=$3 ORDER BY created_at DESC,cursor DESC LIMIT 1",
      ctx.scopeId,
      input.dialogId,
      input.episode
    );
    const repeated = input.nextCursor
      ? await c.one(
          this.db,
          "SELECT 1 FROM dialog_archive_page WHERE scope_id=$1 AND dialog_id=$2 AND episode=$3 AND cursor=$4",
          ctx.scopeId,
          input.dialogId,
          input.episode,
          input.nextCursor
        )
      : null;
    return {
      knownPage: latest?.known_page ?? null,
      cursorRepeated: Boolean(repeated) || Boolean(input.nextCursor && input.cursor === input.nextCursor),
    };
  }
  async listResumableStates(ctx, input = {}) {
    const scope = await this.scope(ctx);
    const records = await c.rows(
      this.db,
      `SELECT * FROM dialog_archive_thread WHERE scope_id=$1 AND state->>'scanHasMore'='true' AND coalesce(state->>'scanCursorId','')<>'' ORDER BY updated_at,dialog_id LIMIT $2`,
      ctx.scopeId,
      Math.min(200, c.integer(input.limit, 50, 1000))
    );
    return records.map((t) => this.state(ctx, scope, t));
  }
  async count(ctx, input) {
    const t = await c.one(
      this.db,
      "SELECT stats FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id=$2",
      ctx.scopeId,
      input.dialogId
    );
    return { messages: Number(t?.stats.messagesCount || 0), media: Number(t?.stats.mediaCount || 0) };
  }
  async listLocalMessageCounts(ctx, input) {
    return (
      await c.rows(
        this.db,
        "SELECT dialog_id,stats,upper_at,upper_id FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id>$2 AND state->>'collectionComplete'='true' ORDER BY dialog_id LIMIT $3",
        ctx.scopeId,
        input.afterDialogId || "",
        Math.min(500, c.integer(input.limit, 100, 1000))
      )
    ).map((t) => ({
      dialogId: t.dialog_id,
      messages: Number(t.stats.messagesCount || 0),
      newestMessageId: t.upper_id,
      newestMessageAt: t.upper_at ? c.iso(t.upper_at) : null,
    }));
  }
  async beginInput(ctx, scope) {
    const s = await this.scope(ctx);
    const t = await c.one(
      this.db,
      "SELECT * FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id=$2",
      ctx.scopeId,
      scope.dialogId
    );
    return {
      archiveScopeId: ctx.scopeId,
      scope: { agencyId: ctx.agencyId, creatorId: ctx.creatorId, dialogId: scope.dialogId },
      epoch: s.epoch,
      revision: Number(t?.revision || 0),
      rewriteRevision: Number(t?.rewrite_revision || 0),
      upper: t?.upper_at ? { createdAt: c.iso(t.upper_at), messageId: t.upper_id } : null,
      collectionFromAt: c.iso(s.collection_from),
    };
  }
  async validateInput(ctx, input, db = this.db) {
    const s = await this.scope(ctx, db);
    c.check(
      input.scope.agencyId === ctx.agencyId &&
        (input.archiveScopeId ? input.archiveScopeId === ctx.scopeId : input.scope.creatorId === ctx.creatorId) &&
        input.epoch === s.epoch,
      "HISTORY_INPUT_CONFLICT"
    );
    const t = await c.one(
      db,
      "SELECT revision,rewrite_revision FROM dialog_archive_thread WHERE scope_id=$1 AND dialog_id=$2",
      ctx.scopeId,
      input.scope.dialogId
    );
    c.check(Number(t?.rewrite_revision || 0) <= input.revision, "HISTORY_INPUT_CONFLICT");
    return Number(t?.revision || 0);
  }
  async readPage(ctx, input, options = {}) {
    return c.transaction(this.db, async (tx) => {
      await this.validateInput(ctx, input, tx);
      if (!input.upper) return { items: [], next: null, done: true, bytes: 2 };
      const maxItems = Math.min(200, c.integer(options.maxItems, 100, 1000)),
        maxBytes = Math.min(262144, c.integer(options.maxBytes, 262144, 1048576));
      const after = options.after;
      const metadata = await c.rows(
        tx,
        `SELECT message_id,storage_bytes FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2
      AND (created_at,length(message_id),message_id)<=($3::timestamptz,length($4::text),$4) AND ($5::timestamptz IS NULL OR (created_at,length(message_id),message_id)>($5::timestamptz,length($6::text),$6))
      ORDER BY created_at,length(message_id),message_id LIMIT $7`,
        ctx.scopeId,
        input.scope.dialogId,
        input.upper.createdAt,
        input.upper.messageId,
        after?.createdAt || null,
        after?.messageId || "",
        maxItems + 1
      );
      const keys = [];
      let bodyBytes = 0;
      for (const row of metadata.slice(0, maxItems)) {
        if (bodyBytes + Number(row.storage_bytes) > maxBytes + MESSAGE_OVERHEAD) {
          c.check(keys.length, "HISTORY_ITEM_TOO_LARGE", 413);
          break;
        }
        keys.push(row.message_id);
        bodyBytes += Number(row.storage_bytes);
      }
      const values = keys.length
        ? await c.rows(
            tx,
            "SELECT * FROM dialog_archive_message WHERE scope_id=$1 AND dialog_id=$2 AND message_id=ANY($3::text[]) ORDER BY created_at,length(message_id),message_id",
            ctx.scopeId,
            input.scope.dialogId,
            keys
          )
        : [];
      const items = [];
      let bytes = 2;
      for (const row of values.slice(0, maxItems)) {
        const m = publicRecord(ctx, input.scope.dialogId, row);
        const item = {
          messageId: m.messageId,
          createdAt: m.createdAt,
          sender: m.sender,
          text: m.text,
          mediaIds: m.mediaIds,
          price: m.price,
          opened: m.opened === 1,
        };
        const size = Buffer.byteLength(JSON.stringify(item)) + (items.length ? 1 : 0);
        if (bytes + size > maxBytes) {
          c.check(items.length, "HISTORY_ITEM_TOO_LARGE", 413);
          break;
        }
        items.push(item);
        bytes += size;
      }
      await this.validateInput(ctx, input, tx);
      const last = items.at(-1);
      return {
        items,
        next: last ? { createdAt: last.createdAt, messageId: last.messageId } : after || null,
        done: metadata.length === items.length,
        bytes,
      };
    });
  }
}
module.exports = { DialogRepository, normalize, comparable, publicRecord, emptyStats, THREAD_BYTES, MESSAGE_OVERHEAD };
