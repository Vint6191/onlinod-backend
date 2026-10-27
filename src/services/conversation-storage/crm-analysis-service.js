"use strict";
const c = require("./common");
const { validateCrmFinalResult, validateCrmHistoryResult } = require("./contracts/crm-validator.cjs");
function config(value) {
  c.bounded(value, 4096);
  c.check(
    value &&
      value.schemaVersion === "crm-final-v1" &&
      ["crm-paged-v1", "crm-paged-v2", "crm-paged-v3"].includes(value.promptVersion),
    "ANALYSIS_CONFIG_NOT_SUPPORTED",
    400
  );
  for (const k of ["provider", "model", "configRevision", "promptVersion", "schemaVersion"]) c.text(value[k], 512);
  return value;
}
class CrmAnalysisService {
  constructor(crm, history, relay) {
    this.crm = crm;
    this.db = crm.db;
    this.history = history;
    this.relay = relay;
  }
  scope(ctx, scope) {
    c.check(scope?.agencyId === ctx.agencyId && scope?.creatorId === ctx.creatorId, "ANALYSIS_SCOPE_INVALID", 403);
    c.platformId(scope.dialogId);
    return scope.dialogId;
  }
  view(ctx, row) {
    return {
      scope: { agencyId: ctx.agencyId, creatorId: ctx.creatorId, dialogId: row.fan_id },
      runId: row.run_id,
      leaseToken: row.lease_token,
      generation: Number(row.generation),
      config: row.config,
      input: row.input,
      completedPages: row.completed_pages,
      completedMessages: Number(row.completed_messages),
      leaseUntil: new Date(row.lease_until).getTime(),
      inputDone: row.input_done,
      baseMessages: Number(row.base_messages),
    };
  }
  async owned(ctx, ref, db = this.db) {
    this.scope(ctx, ref.scope);
    if (db !== this.db) await c.one(db, "SELECT scope_id FROM crm_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
    const row = await c.one(
      db,
      `SELECT r.* FROM crm_analysis_run r JOIN crm_analysis_work w ON w.scope_id=r.scope_id AND w.fan_id=r.fan_id AND w.active_run_id=r.run_id
    WHERE r.run_id=$1 AND r.scope_id=$2 AND r.fan_id=$3 AND r.lease_until>now() ${db === this.db ? "" : "FOR UPDATE OF r,w"}`,
      ref.runId,
      ctx.scopeId,
      ref.scope.dialogId
    );
    c.check(
      row &&
        row.state === "RUNNING" &&
        row.lease_token === ref.leaseToken &&
        row.lease_device === ctx.deviceId &&
        row.lease_actor === ctx.actorId &&
        new Date(row.lease_until).getTime() > Date.now(),
      "ANALYSIS_LEASE_NOT_CURRENT"
    );
    return row;
  }
  async publish(ctx, fanId, tx) {
    const work = await c.one(tx, "SELECT * FROM crm_analysis_work WHERE scope_id=$1 AND fan_id=$2", ctx.scopeId, fanId);
    if (!work) return;
    const run = work.active_run_id
      ? await c.one(tx, "SELECT completed_pages FROM crm_analysis_run WHERE run_id=$1", work.active_run_id)
      : null;
    const phase =
      work.state === "DONE"
        ? "done"
        : work.state === "ERROR"
          ? "error"
          : work.state === "RUNNING"
            ? "history"
            : work.last_error === "WAITING_SCAN"
              ? "waiting_scan"
              : "queued";
    const patch = {
      analysisStatus: work.state === "READY" ? "queued" : work.state.toLowerCase(),
      analysisModel: work.config.model,
      analysisProgress: {
        phase,
        completed: run?.completed_pages || 0,
        total: 0,
        message:
          phase === "done"
            ? "Анализ сохранён"
            : phase === "waiting_scan"
              ? "Ожидает историю"
              : phase === "queued"
                ? "Ожидает исполнителя"
                : phase === "error"
                  ? "Анализ остановлен"
                  : "Анализ истории",
      },
      error: work.last_error || "",
    };
    await c.exec(
      tx,
      "UPDATE crm_profile SET profile=profile || $3::jsonb WHERE scope_id=$1 AND fan_id=$2",
      ctx.scopeId,
      fanId,
      JSON.stringify(patch)
    );
  }
  async ensureAutomatic(ctx, scope, value) {
    const fanId = this.scope(ctx, scope);
    config(value);
    await this.relay.scope(ctx);
    const state = await this.history.getState(ctx, { dialogId: fanId }),
      count = await this.history.count(ctx, { dialogId: fanId });
    if (!state.collectionComplete || state.scanHasMore || !count.messages) return;
    const head = await this.history.beginInput(ctx, scope);
    await this.crm.receiveHistory(ctx, {
      dialogId: fanId,
      epoch: head.epoch,
      revision: head.revision,
      rewriteRevision: head.rewriteRevision,
    });
    await c.transaction(this.db, async (tx) => {
      const profile = await this.crm.ensure(ctx, fanId, tx);
      await c.one(tx, "SELECT scope_id FROM crm_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
      const current = await c.one(
        tx,
        "SELECT * FROM crm_analysis_work WHERE scope_id=$1 AND fan_id=$2",
        ctx.scopeId,
        fanId
      );
      if (current && current.state !== "DONE") return;
      if (
        current &&
        profile.accepted_input?.epoch === profile.history_epoch &&
        profile.accepted_input?.revision === Number(profile.history_revision)
      )
        return;
      await c.exec(
        tx,
        `INSERT INTO crm_analysis_work(scope_id,fan_id,config) VALUES($1,$2,$3::jsonb) ON CONFLICT(scope_id,fan_id)
        DO UPDATE SET generation=crm_analysis_work.generation+1,state='READY',next_run_at=now(),last_error=''`,
        ctx.scopeId,
        fanId,
        JSON.stringify(current?.config || value)
      );
      await this.publish(ctx, fanId, tx);
    });
  }
  async request(ctx, scope, input) {
    const fanId = this.scope(ctx, scope);
    config(input.config);
    return this.crm.command(
      ctx,
      input.commandId,
      { kind: "analysis.request", fanId, config: input.config, force: input.force === true },
      async (tx) => {
        await this.crm.ensure(ctx, fanId, tx);
        const old = await c.one(
          tx,
          "SELECT * FROM crm_analysis_work WHERE scope_id=$1 AND fan_id=$2",
          ctx.scopeId,
          fanId
        );
        const coalesce =
          old &&
          ["READY", "RUNNING"].includes(old.state) &&
          c.hash(old.config) === c.hash(input.config) &&
          !input.force;
        const generation = Number(old?.generation || 0) + (coalesce ? 0 : 1);
        await c.exec(
          tx,
          `INSERT INTO crm_analysis_work(scope_id,fan_id,generation,config,lane,allow_prefix) VALUES($1,$2,$3,$4::jsonb,$5,$6)
      ON CONFLICT(scope_id,fan_id) DO UPDATE SET generation=EXCLUDED.generation,config=EXCLUDED.config,lane=EXCLUDED.lane,allow_prefix=EXCLUDED.allow_prefix,
      state=CASE WHEN crm_analysis_work.state='RUNNING' THEN 'RUNNING' ELSE 'READY' END,next_run_at=CASE WHEN $7 THEN crm_analysis_work.next_run_at ELSE now() END,last_error='',failures=0`,
          ctx.scopeId,
          fanId,
          generation,
          JSON.stringify(input.config),
          input.force ? 1 : 0,
          !input.force,
          Boolean(coalesce)
        );
        await this.publish(ctx, fanId, tx);
        return { generation };
      }
    );
  }
  async work(ctx, scope) {
    const fanId = this.scope(ctx, scope);
    await this.relay.scope(ctx);
    const w = await c.one(
      this.db,
      "SELECT w.*,p.accepted_input,p.history_revision,p.history_epoch FROM crm_analysis_work w JOIN crm_profile p USING(scope_id,fan_id) WHERE scope_id=$1 AND fan_id=$2",
      ctx.scopeId,
      fanId
    );
    return w
      ? {
          state: w.state,
          generation: Number(w.generation),
          config: w.config,
          nextRunAt: new Date(w.next_run_at).getTime(),
          dirty:
            !w.accepted_input ||
            w.accepted_input.epoch !== w.history_epoch ||
            w.accepted_input.revision !== Number(w.history_revision),
          lane: w.lane,
          error: w.last_error,
        }
      : null;
  }
  async status(ctx, scope, id) {
    this.scope(ctx, scope);
    const row = await c.one(
      this.db,
      "SELECT result FROM crm_command_receipt WHERE scope_id=$1 AND command_id=$2",
      ctx.scopeId,
      id
    );
    return row?.result ?? null;
  }
  async claim(ctx, scope, id) {
    const fanId = this.scope(ctx, scope);
    const replay = await this.crm.receipt(ctx, id, { kind: "analysis.claim", fanId });
    if (replay) return replay.run;
    const input = await this.history.beginInput(ctx, scope);
    if (!input.upper) return null;
    const priorWork = await c.one(
      this.db,
      "SELECT * FROM crm_analysis_work WHERE scope_id=$1 AND fan_id=$2",
      ctx.scopeId,
      fanId
    );
    const prior = priorWork?.active_run_id
      ? await c.one(this.db, "SELECT * FROM crm_analysis_run WHERE run_id=$1", priorWork.active_run_id)
      : null;
    let canResume = false;
    if (prior && prior.state === "RUNNING" && Number(prior.generation) === Number(priorWork.generation)) {
      try {
        await this.history.validateInput(ctx, prior.input);
        canResume = true;
      } catch (error) {
        if (error.code !== "HISTORY_INPUT_CONFLICT") throw error;
      }
    }
    const result = await this.crm.command(ctx, id, { kind: "analysis.claim", fanId }, async (tx) => {
      const work = await c.one(
        tx,
        "SELECT * FROM crm_analysis_work WHERE scope_id=$1 AND fan_id=$2 FOR UPDATE",
        ctx.scopeId,
        fanId
      );
      if (!work || !["READY", "RUNNING"].includes(work.state) || new Date(work.next_run_at).getTime() > Date.now())
        return { run: null };
      const previous = work.active_run_id
        ? await c.one(tx, "SELECT * FROM crm_analysis_run WHERE run_id=$1", work.active_run_id)
        : null;
      if (previous?.state === "RUNNING" && new Date(previous.lease_until).getTime() > Date.now()) return { run: null };
      const token = c.randomUUID();
      let run;
      if (canResume && previous?.run_id === prior.run_id && Number(previous.generation) === Number(work.generation))
        run = await c.one(
          tx,
          `UPDATE crm_analysis_run SET lease_token=$2,lease_device=$3,lease_actor=$4,lease_until=now()+interval '2 minutes',updated_at=now() WHERE run_id=$1 RETURNING *`,
          previous.run_id,
          token,
          ctx.deviceId,
          ctx.actorId
        );
      else {
        if (previous)
          await c.exec(tx, "UPDATE crm_analysis_run SET state='SUPERSEDED' WHERE run_id=$1", previous.run_id);
        const persona = await this.crm.scope(ctx, tx);
        const p = await this.crm.ensure(ctx, fanId, tx);
        const basis = p.analysis_basis;
        const reuse =
          work.allow_prefix &&
          basis &&
          Number(basis.personaRevision) === Number(persona.persona_revision) &&
          basis.input?.epoch === input.epoch &&
          basis.input.revision >= input.rewriteRevision &&
          c.hash(basis.config) === c.hash(work.config);
        run = await c.one(
          tx,
          `INSERT INTO crm_analysis_run(run_id,scope_id,fan_id,generation,lease_token,lease_device,lease_actor,lease_until,config,input,persona_revision,cursor,summary,completed_messages,base_messages)
          VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 minutes',$8::jsonb,$9::jsonb,$10,$11::jsonb,$12::jsonb,$13,$13) RETURNING *`,
          c.randomUUID(),
          ctx.scopeId,
          fanId,
          work.generation,
          token,
          ctx.deviceId,
          ctx.actorId,
          JSON.stringify(work.config),
          JSON.stringify(input),
          persona.persona_revision,
          reuse ? JSON.stringify(basis.input.upper) : null,
          reuse ? JSON.stringify(basis.summary) : null,
          reuse ? basis.processedMessages : 0
        );
      }
      await c.exec(
        tx,
        "UPDATE crm_analysis_work SET state='RUNNING',active_run_id=$3 WHERE scope_id=$1 AND fan_id=$2",
        ctx.scopeId,
        fanId,
        run.run_id
      );
      await this.publish(ctx, fanId, tx);
      return { run: this.view(ctx, run) };
    });
    return result.run;
  }
  async renew(ctx, ref) {
    return c.transaction(this.db, async (tx) => {
      const r = await this.owned(ctx, ref, tx);
      const next = await c.one(
        tx,
        "UPDATE crm_analysis_run SET lease_until=now()+interval '2 minutes' WHERE run_id=$1 RETURNING lease_until",
        r.run_id
      );
      return new Date(next.lease_until).getTime();
    });
  }
  async progress(ctx, ref) {
    const r = await this.owned(ctx, ref);
    await this.history.validateInput(ctx, r.input);
    return {
      run: this.view(ctx, r),
      context: r.context,
      throughPage: r.reduction_through,
      summary: r.summary,
      final: r.final,
    };
  }
  async bindContext(ctx, ref, value) {
    c.bounded(value, 32768);
    return c.transaction(this.db, async (tx) => {
      const r = await this.owned(ctx, ref, tx);
      if (r.context) return r.context;
      await c.exec(
        tx,
        "UPDATE crm_analysis_run SET context=$2::jsonb WHERE run_id=$1",
        r.run_id,
        JSON.stringify(value)
      );
      return value;
    });
  }
  async readNextPage(ctx, ref) {
    const r = await this.owned(ctx, ref);
    c.check(!r.input_done, "ANALYSIS_INPUT_COMPLETE");
    c.check(r.completed_pages === r.reduction_through + 1, "ANALYSIS_REDUCTION_REQUIRED");
    const page = await this.history.readPage(ctx, r.input, { after: r.cursor, maxItems: 100, maxBytes: 65536 });
    const proof = {
      pageNumber: r.completed_pages,
      hash: c.hash(page.items),
      count: page.items.length,
      next: page.next,
      done: page.done,
    };
    await c.transaction(this.db, async (tx) => {
      const current = await this.owned(ctx, ref, tx);
      c.check(
        current.completed_pages === r.completed_pages && c.hash(current.cursor) === c.hash(r.cursor),
        "ANALYSIS_PAGE_CHANGED"
      );
      if (current.pending) c.check(c.hash(current.pending) === c.hash(proof), "ANALYSIS_PAGE_CHANGED");
      else
        await c.exec(
          tx,
          "UPDATE crm_analysis_run SET pending=$2::jsonb WHERE run_id=$1",
          r.run_id,
          JSON.stringify(proof)
        );
    });
    return { ...page, proof };
  }
  async checkpoint(ctx, ref, input) {
    return c.transaction(this.db, async (tx) => {
      const r = await this.owned(ctx, ref, tx);
      validateCrmHistoryResult(input.summary, r.config);
      const old = await c.one(
        tx,
        "SELECT * FROM crm_analysis_chunk WHERE run_id=$1 AND page_number=$2",
        r.run_id,
        input.pageNumber
      );
      if (old) {
        c.check(
          old.page_hash === input.pageHash && c.hash(old.summary) === c.hash(input.summary),
          "ANALYSIS_CHECKPOINT_CONFLICT"
        );
        return;
      }
      c.check(
        r.pending &&
          r.pending.pageNumber === input.pageNumber &&
          r.pending.hash === input.pageHash &&
          r.completed_pages === input.pageNumber,
        "ANALYSIS_PAGE_PROOF_INVALID"
      );
      await c.exec(
        tx,
        "INSERT INTO crm_analysis_chunk(run_id,page_number,page_hash,summary) VALUES($1,$2,$3,$4::jsonb)",
        r.run_id,
        input.pageNumber,
        input.pageHash,
        JSON.stringify(input.summary)
      );
      await c.exec(
        tx,
        "UPDATE crm_analysis_run SET completed_pages=completed_pages+1,completed_messages=completed_messages+$2,cursor=$3::jsonb,input_done=$4,pending=NULL,updated_at=now() WHERE run_id=$1",
        r.run_id,
        r.pending.count,
        JSON.stringify(r.pending.next),
        r.pending.done
      );
      await this.publish(ctx, r.fan_id, tx);
    });
  }
  async readCheckpoints(ctx, ref, after = -1, limit = 1) {
    await this.owned(ctx, ref);
    return (
      await c.rows(
        this.db,
        "SELECT * FROM crm_analysis_chunk WHERE run_id=$1 AND page_number>$2 ORDER BY page_number LIMIT $3",
        ref.runId,
        after,
        Math.min(16, limit)
      )
    ).map((r) => ({ pageNumber: r.page_number, summary: r.summary }));
  }
  async saveReduction(ctx, ref, input) {
    return c.transaction(this.db, async (tx) => {
      const r = await this.owned(ctx, ref, tx);
      validateCrmHistoryResult(input.summary, r.config);
      if (r.reduction_through === input.throughPage) {
        c.check(c.hash(r.summary) === c.hash(input.summary), "ANALYSIS_REDUCTION_CONFLICT");
        return;
      }
      c.check(
        input.throughPage === r.reduction_through + 1 && input.throughPage < r.completed_pages && !r.final,
        "ANALYSIS_REDUCTION_GAP"
      );
      await c.exec(
        tx,
        "UPDATE crm_analysis_run SET summary=$2::jsonb,reduction_through=$3 WHERE run_id=$1",
        r.run_id,
        JSON.stringify(input.summary),
        input.throughPage
      );
      // Keep the last reduced checkpoint for ambiguous response replay; older summaries are no longer needed.
      await c.exec(
        tx,
        "DELETE FROM crm_analysis_chunk WHERE run_id=$1 AND page_number<$2",
        r.run_id,
        input.throughPage
      );
    });
  }
  async saveFinal(ctx, ref, value) {
    return c.transaction(this.db, async (tx) => {
      const r = await this.owned(ctx, ref, tx);
      validateCrmFinalResult(value, r.config);
      c.check(
        r.input_done && r.summary && r.reduction_through === r.completed_pages - 1,
        "ANALYSIS_REDUCTION_INCOMPLETE"
      );
      if (r.final) c.check(c.hash(r.final) === c.hash(value), "ANALYSIS_FINAL_CONFLICT");
      else
        await c.exec(
          tx,
          "UPDATE crm_analysis_run SET final=$2::jsonb WHERE run_id=$1",
          r.run_id,
          JSON.stringify(value)
        );
    });
  }
  async complete(ctx, ref, id, value) {
    const replay = await this.crm.receipt(ctx, id, { kind: "analysis.complete", runId: ref.runId, value });
    if (replay) return replay;
    const r = await this.owned(ctx, ref);
    await this.history.validateInput(ctx, r.input);
    return this.crm.command(ctx, id, { kind: "analysis.complete", runId: ref.runId, value }, async (tx) => {
      const row = await this.owned(ctx, ref, tx);
      c.check(row.input_done && row.final && c.hash(row.final) === c.hash(value), "ANALYSIS_FINAL_NOT_PREPARED");
      const work = await c.one(
        tx,
        "SELECT * FROM crm_analysis_work WHERE scope_id=$1 AND fan_id=$2",
        ctx.scopeId,
        row.fan_id
      );
      const persona = await this.crm.scope(ctx, tx);
      const superseded =
        Number(work.generation) !== Number(row.generation) ||
        Number(persona.persona_revision) !== Number(row.persona_revision);
      const receipt = {
        commandId: id,
        status: superseded ? "superseded" : "accepted",
        runId: row.run_id,
        generation: Number(row.generation),
        processedMessages: Number(row.completed_messages),
      };
      if (!superseded) {
        const patch = validateCrmFinalResult(value, row.config);
        delete patch.replySuggestions;
        patch.analysisStatus = "done";
        patch.analysisUpdatedAt = new Date().toISOString();
        patch.analysisModel = row.config.model;
        await this.crm.applyAiPatch(ctx, row.fan_id, patch, tx);
        await c.exec(
          tx,
          "UPDATE crm_profile SET accepted_input=$3::jsonb,analysis_basis=$4::jsonb WHERE scope_id=$1 AND fan_id=$2",
          ctx.scopeId,
          row.fan_id,
          JSON.stringify(row.input),
          JSON.stringify({
            input: row.input,
            config: row.config,
            personaRevision: Number(row.persona_revision),
            summary: row.summary,
            processedMessages: Number(row.completed_messages),
          })
        );
      }
      await c.exec(
        tx,
        "UPDATE crm_analysis_run SET state=$2,result=$3::jsonb,lease_until=now(),updated_at=now() WHERE run_id=$1",
        row.run_id,
        superseded ? "SUPERSEDED" : "DONE",
        JSON.stringify(receipt)
      );
      const head = await c.one(
        tx,
        "SELECT history_epoch,history_revision FROM crm_profile WHERE scope_id=$1 AND fan_id=$2",
        ctx.scopeId,
        row.fan_id
      );
      const appended =
        !superseded && head.history_epoch === row.input.epoch && Number(head.history_revision) > row.input.revision;
      await c.exec(
        tx,
        "UPDATE crm_analysis_work SET state=$3,generation=generation+$4,active_run_id=NULL,next_run_at=now(),last_error='',failures=0 WHERE scope_id=$1 AND fan_id=$2",
        ctx.scopeId,
        row.fan_id,
        superseded || appended ? "READY" : "DONE",
        appended ? 1 : 0
      );
      await this.publish(ctx, row.fan_id, tx);
      return receipt;
    });
  }
  async defer(ctx, ref, delay, id, error, cancel = false) {
    return this.crm.command(
      ctx,
      id,
      { kind: cancel ? "cancel" : "defer", runId: ref.runId, delay, error },
      async (tx) => {
        const r = await this.owned(ctx, ref, tx);
        const work = await c.one(
          tx,
          "SELECT * FROM crm_analysis_work WHERE scope_id=$1 AND fan_id=$2",
          ctx.scopeId,
          r.fan_id
        );
        const failures = work.failures + 1;
        const state = cancel || failures >= 4 ? "ERROR" : "READY";
        await c.exec(
          tx,
          "UPDATE crm_analysis_run SET state='CANCELLED',lease_until=now(),updated_at=now() WHERE run_id=$1",
          r.run_id
        );
        await c.exec(
          tx,
          "UPDATE crm_analysis_work SET state=$3,active_run_id=NULL,failures=$4,last_error=$5,next_run_at=now()+($6::integer*interval '1 millisecond') WHERE scope_id=$1 AND fan_id=$2",
          ctx.scopeId,
          r.fan_id,
          state,
          failures,
          String(error || "").slice(0, 512),
          Math.min(300000, Math.max(1000, delay || 30000))
        );
        await this.publish(ctx, r.fan_id, tx);
        return { status: cancel ? "cancelled" : "deferred", runId: r.run_id };
      }
    );
  }
  async listDue(ctx, scope, options = {}) {
    c.check(scope.agencyId === ctx.agencyId && scope.creatorId === ctx.creatorId, "ANALYSIS_SCOPE_INVALID", 403);
    await this.relay.scope(ctx);
    const state = options.state || "READY";
    c.check(["READY", "RUNNING", "ERROR"].includes(state), "ANALYSIS_STATE_INVALID", 400);
    return (
      await c.rows(
        this.db,
        `SELECT w.fan_id,w.next_run_at FROM crm_analysis_work w LEFT JOIN crm_analysis_run r ON r.run_id=w.active_run_id
      WHERE w.scope_id=$1 AND w.state=$2 AND ($3::integer IS NULL OR w.lane=$3) AND w.next_run_at<=now()
      AND (w.state<>'RUNNING' OR r.lease_until<=now()) AND ($4::timestamptz IS NULL OR (w.next_run_at,w.fan_id)>($4::timestamptz,$5))
      ORDER BY w.next_run_at,w.fan_id LIMIT $6`,
        ctx.scopeId,
        state,
        options.lane ?? null,
        options.after ? new Date(options.after.nextRunAt).toISOString() : null,
        options.after?.dialogId || "",
        Math.min(64, options.limit || 16)
      )
    ).map((r) => ({ dialogId: r.fan_id, nextRunAt: new Date(r.next_run_at).getTime() }));
  }
  async discover(ctx, scope, options) {
    await this.relay.scope(ctx);
    const cursor = (await this.crm.scope(ctx)).discovery_after || "",
      limit = Math.min(64, c.integer(options.limit, 64, 64));
    const records = await c.rows(
      this.db,
      `SELECT p.fan_id FROM crm_profile p LEFT JOIN crm_analysis_work w USING(scope_id,fan_id)
      WHERE p.scope_id=$1 AND p.fan_id>$2 AND p.history_revision>0 AND (p.accepted_input IS NULL OR p.accepted_input->>'epoch' IS DISTINCT FROM p.history_epoch OR (p.accepted_input->>'revision')::bigint<p.history_revision)
      AND (w.fan_id IS NULL OR w.state='DONE') ORDER BY p.fan_id LIMIT $3`,
      ctx.scopeId,
      cursor,
      limit
    );
    for (const p of records) await this.ensureAutomatic(ctx, { ...scope, dialogId: p.fan_id }, options.config);
    await c.exec(
      this.db,
      "UPDATE crm_scope SET discovery_after=$3 WHERE scope_id=$1 AND discovery_after=$2",
      ctx.scopeId,
      cursor,
      records.length === limit ? records.at(-1).fan_id : ""
    );
    return { visited: records.length, more: records.length === limit };
  }
  async waitForScan(ctx, scope, generation) {
    const fanId = this.scope(ctx, scope);
    const n = await c.exec(
      this.db,
      "UPDATE crm_analysis_work SET state='READY',last_error='WAITING_SCAN',next_run_at=now()+interval '30 seconds' WHERE scope_id=$1 AND fan_id=$2 AND generation=$3 AND state='READY'",
      ctx.scopeId,
      fanId,
      generation
    );
    return Boolean(n);
  }
  async recoverProviderFailure(ctx, scope, expected) {
    const fanId = this.scope(ctx, scope);
    config(expected.config);
    return Boolean(
      await c.exec(
        this.db,
        "UPDATE crm_analysis_work SET state='READY',next_run_at=now(),failures=0,last_error='' WHERE scope_id=$1 AND fan_id=$2 AND generation=$3 AND state='ERROR' AND last_error=$4",
        ctx.scopeId,
        fanId,
        expected.generation,
        expected.error
      )
    );
  }
  async collect(ctx, scope, limit = 32) {
    await this.crm.scope(ctx);
    const removed = await c.rows(
      this.db,
      `DELETE FROM crm_analysis_run WHERE run_id IN (SELECT run_id FROM crm_analysis_run WHERE scope_id=$1 AND state<>'RUNNING' AND updated_at<now()-interval '2 days' ORDER BY updated_at LIMIT $2) RETURNING run_id`,
      ctx.scopeId,
      Math.min(64, limit)
    );
    await c.exec(
      this.db,
      "DELETE FROM crm_reply_run WHERE token IN (SELECT token FROM crm_reply_run WHERE scope_id=$1 AND expires_at<now() ORDER BY expires_at LIMIT 64)",
      ctx.scopeId
    );
    return { chunks: 0, runs: removed.length };
  }
  async beginReplies(ctx, scope, token) {
    const fanId = this.scope(ctx, scope);
    c.commandId(token);
    const history = await this.history.beginInput(ctx, scope),
      profile = await this.crm.getProfile(ctx, fanId),
      persona = await this.crm.scope(ctx);
    const messages = (await this.history.getMessages(ctx, { dialogId: fanId, limit: 40, order: "desc" }))
      .filter(
        (m) =>
          history.upper &&
          (m.createdAt < history.upper.createdAt ||
            (m.createdAt === history.upper.createdAt &&
              (m.messageId.length < history.upper.messageId.length ||
                (m.messageId.length === history.upper.messageId.length && m.messageId <= history.upper.messageId))))
      )
      .reverse()
      .map((m) => ({
        messageId: m.messageId,
        createdAt: m.createdAt,
        sender: m.sender,
        text: m.text,
        mediaIds: m.mediaIds,
        price: m.price,
        opened: m.opened === 1,
      }));
    c.check(messages.length, "CRM_NO_MESSAGES");
    c.bounded(messages, 32768);
    await this.history.validateInput(ctx, history);
    await c.transaction(this.db, async (tx) => {
      await c.one(tx, "SELECT scope_id FROM crm_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
      const current = await this.crm.ensure(ctx, fanId, tx),
        currentPersona = await this.crm.scope(ctx, tx);
      c.check(
        Number(current.revision) === profile.revision &&
          Number(currentPersona.persona_revision) === Number(persona.persona_revision),
        "CRM_REPLY_PROFILE_CHANGED"
      );
      const saved = await c.one(tx, "SELECT * FROM crm_reply_run WHERE token=$1", token);
      if (saved) {
        c.check(
          saved.scope_id === ctx.scopeId &&
            saved.fan_id === fanId &&
            saved.device_id === ctx.deviceId &&
            saved.actor_id === ctx.actorId &&
            current.reply_token === token &&
            !saved.result_hash &&
            new Date(saved.expires_at).getTime() > Date.now(),
          "CRM_REPLY_SUPERSEDED"
        );
        c.check(
          c.hash(saved.input) === c.hash(history) &&
            Number(saved.profile_revision) === profile.revision &&
            Number(saved.persona_revision) === Number(persona.persona_revision),
          "CRM_REPLY_INPUT_CHANGED"
        );
        return;
      }
      await c.exec(
        tx,
        "INSERT INTO crm_reply_run(token,scope_id,fan_id,device_id,actor_id,input,profile_revision,persona_revision) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
        token,
        ctx.scopeId,
        fanId,
        ctx.deviceId,
        ctx.actorId,
        JSON.stringify(history),
        profile.revision,
        persona.persona_revision
      );
      await c.exec(
        tx,
        "UPDATE crm_profile SET reply_token=$3 WHERE scope_id=$1 AND fan_id=$2",
        ctx.scopeId,
        fanId,
        token
      );
    });
    return { token, profile, messages };
  }
  async completeReplies(ctx, scope, input) {
    const fanId = this.scope(ctx, scope);
    c.bounded(input.raw, 16384);
    const list = input.raw?.reply_suggestions;
    c.check(
      Object.keys(c.object(input.raw)).length === 1 && Array.isArray(list) && list.length > 0 && list.length <= 4,
      "CRM_REPLY_SCHEMA_INVALID",
      400
    );
    for (const r of list)
      c.check(
        r &&
          typeof r.text === "string" &&
          r.text.trim().length >= 4 &&
          r.text.length <= 700 &&
          typeof r.tone === "string" &&
          r.tone.length <= 80 &&
          ["rapport", "flirty", "sexual", "sale", "follow_up", "custom", "reactivation"].includes(r.intent) &&
          typeof r.confidence === "number" &&
          r.confidence >= 0 &&
          r.confidence <= 1,
        "CRM_REPLY_SCHEMA_INVALID",
        400
      );
    const saved = await c.one(
      this.db,
      "SELECT * FROM crm_reply_run WHERE token=$1 AND scope_id=$2 AND fan_id=$3",
      input.token,
      ctx.scopeId,
      fanId
    );
    c.check(
      saved &&
        saved.device_id === ctx.deviceId &&
        saved.actor_id === ctx.actorId &&
        new Date(saved.expires_at).getTime() > Date.now(),
      "CRM_REPLY_SUPERSEDED"
    );
    const digest = c.hash(list);
    if (saved.result_hash) {
      c.check(saved.result_hash === digest, "CRM_REPLY_RESULT_CONFLICT");
      return;
    }
    const revision = await this.history.validateInput(ctx, saved.input);
    c.check(revision === saved.input.revision, "CRM_REPLY_HISTORY_CHANGED");
    await c.transaction(this.db, async (tx) => {
      await c.one(tx, "SELECT scope_id FROM crm_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
      const p = await c.one(
        tx,
        "SELECT * FROM crm_profile WHERE scope_id=$1 AND fan_id=$2 FOR UPDATE",
        ctx.scopeId,
        fanId
      );
      const persona = await this.crm.scope(ctx, tx);
      const locked = await c.one(tx, "SELECT result_hash FROM crm_reply_run WHERE token=$1 FOR UPDATE", input.token);
      if (locked?.result_hash) {
        c.check(locked.result_hash === digest, "CRM_REPLY_RESULT_CONFLICT");
        return;
      }
      c.check(
        p.reply_token === input.token &&
          Number(p.revision) === Number(saved.profile_revision) &&
          Number(persona.persona_revision) === Number(saved.persona_revision),
        "CRM_REPLY_PROFILE_CHANGED"
      );
      await c.exec(
        tx,
        "UPDATE crm_profile SET profile=profile || $3::jsonb WHERE scope_id=$1 AND fan_id=$2",
        ctx.scopeId,
        fanId,
        JSON.stringify({ replySuggestions: list })
      );
      await c.exec(tx, "UPDATE crm_reply_run SET result_hash=$2 WHERE token=$1", input.token, digest);
    });
  }
}
module.exports = { CrmAnalysisService, config };
