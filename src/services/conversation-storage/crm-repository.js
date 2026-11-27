"use strict";
const c = require("./common");
const defaults = require("./crm-profile-default.json");
const editLimits = require("../../contracts/crm-edit-limits.json");
const personaLimits = require("../../contracts/creator-ai-profile-limits.json");
const MANUAL = new Set(defaults.manualFields);
const FORBIDDEN = new Set([
  "analysis",
  "analysisStatus",
  "analysisProgress",
  "analysisModel",
  "analysisUpdatedAt",
  "manualFields",
  "platformUsername",
  "platformDisplayName",
  "inferredPersonalName",
  "revision",
  "fieldVersions",
]);
function currentIdentity(profile, identity) {
  if (!identity) return profile;
  const p = { ...profile, platformUsername: identity.username || "",
    platformDisplayName: identity.platformDisplayName || "" };
  p.fanName = p.preferredName || p.inferredPersonalName || p.legacyUnclassifiedName || p.platformDisplayName || "";
  p.fanUsername = p.platformUsername;
  return p;
}
function profileValue(row, notes = []) {
  const revision = Number(row.revision);
  c.check(Number.isSafeInteger(revision) && revision >= 0, "CRM_REVISION_OVERFLOW", 503);
  const p = {
    ...globalThis.structuredClone(defaults.profile),
    ...row.profile,
    notesManual: notes.map((n) => n.text),
    manualFields: row.manual_fields,
    revision,
    fieldVersions: row.field_versions,
  };
  delete p._replyInput;
  p.fanName = p.preferredName || p.inferredPersonalName || p.legacyUnclassifiedName || p.platformDisplayName || "";
  p.fanUsername = p.platformUsername || "";
  return p;
}
function cleanPatch(raw) {
  c.bounded(raw, editLimits.patchBytesMax);
  const patch = {};
  for (const [key, value] of Object.entries(raw)) {
    c.check(Object.hasOwn(defaults.profile, key), "CRM_FIELD_UNKNOWN", 400);
    const sample = defaults.profile[key];
    if (typeof sample === "string")
      c.check(typeof value === "string" && value.length <= editLimits.fieldTextMax, "CRM_FIELD_INVALID", 400);
    else if (Array.isArray(sample)) c.check(Array.isArray(value) && value.length <= 80, "CRM_FIELD_INVALID", 400);
    else if (sample === null)
      c.check(
        value === null ||
          (key.endsWith("At")
            ? typeof value === "string" && Number.isFinite(Date.parse(value))
            : typeof value === "number" && Number.isFinite(value) && value >= 0),
        "CRM_FIELD_INVALID",
        400
      );
    else if (sample && typeof sample === "object")
      c.check(value && typeof value === "object" && !Array.isArray(value), "CRM_FIELD_INVALID", 400);
    patch[key] = value;
  }
  if (patch.budgetMin != null && patch.budgetMax != null)
    c.check(patch.budgetMin <= patch.budgetMax, "CRM_BUDGET_INVALID", 400);
  for (const key of ["boundaries", "negations"])
    if (patch[key])
      for (const item of patch[key]) c.check(typeof item === "string" && item.length <= 2000, "CRM_FIELD_INVALID", 400);
  for (const key of ["fetishes", "contentPreferences", "turnOnTriggers", "requestedContent"])
    if (patch[key])
      for (const item of patch[key]) {
        c.check(
          item &&
            typeof item === "object" &&
            !Array.isArray(item) &&
            typeof item.label === "string" &&
            item.label.trim() &&
            item.label.length <= 120,
          "CRM_FIELD_INVALID",
          400
        );
        c.bounded(item, 2048);
        if (item.strength != null)
          c.check(["strong", "medium", "weak"].includes(item.strength), "CRM_FIELD_INVALID", 400);
        for (const field of ["facets", "raw"])
          if (item[field] != null)
            c.check(
              Array.isArray(item[field]) &&
                item[field].length <= 12 &&
                item[field].every((v) => typeof v === "string" && v.length <= 600),
              "CRM_FIELD_INVALID",
              400
            );
      }
  if (patch.sexualDynamic)
    for (const [key, value] of Object.entries(patch.sexualDynamic))
      c.check(
        Object.hasOwn(defaults.profile.sexualDynamic, key) && typeof value === "string" && value.length <= 2000,
        "CRM_FIELD_INVALID",
        400
      );
  return patch;
}
function validateMergedProfile(profile) {
  if (profile.budgetMin != null && profile.budgetMax != null)
    c.check(profile.budgetMin <= profile.budgetMax, "CRM_BUDGET_INVALID", 400);
  return profile;
}
function boundStoredProfile(profile) {
  const { _replyInput, ...publicProfile } = profile;
  c.bounded(publicProfile, 65536);
  if (_replyInput !== undefined) c.bounded(_replyInput, 4096);
}
class CrmRepository {
  constructor(db, dialogs, canonical = null, admitGrowth = async () => {}) {
    this.db = db;
    this.dialogs = dialogs;
    this.canonical = canonical;
    this.admitGrowth = admitGrowth;
  }
  async identities(ctx, fanIds) {
    if (!this.canonical || !fanIds.length) return new Map();
    const ids = [...new Set(fanIds.map(c.platformId))];
    c.check(ids.length <= 100, "CRM_IDENTITY_PAGE_TOO_LARGE", 400);
    const rows = await this.canonical.read(ctx, ids);
    return new Map(rows.filter(row => ids.includes(String(row.onlyFansUserId)))
      .map(row => [String(row.onlyFansUserId), row.platformIdentity]));
  }
  async identityToken(ctx, fanId) {
    const identity = (await this.identities(ctx, [fanId])).get(fanId);
    return c.hash({ username: identity?.username || "", platformDisplayName: identity?.platformDisplayName || "" });
  }
  async identityRevision(ctx) {
    return this.canonical ? BigInt(await this.canonical.revision(ctx)) : 0n;
  }
  combinedRevision(crmRevision, identityRevision) {
    const revision = BigInt(crmRevision || 0) + identityRevision;
    c.check(revision >= 0n && revision <= BigInt(Number.MAX_SAFE_INTEGER), "CAMPAIGN_REVISION_OVERFLOW", 503);
    return Number(revision);
  }
  async readRevision(ctx) {
    const identity = await this.identityRevision(ctx);
    const scope = await c.one(this.db, "SELECT revision FROM crm_scope WHERE scope_id=$1 AND agency_id=$2", ctx.scopeId, ctx.agencyId);
    return this.combinedRevision(scope?.revision, identity);
  }
  async scope(ctx, db = this.db) {
    await c.exec(
      db,
      "INSERT INTO crm_scope(scope_id,agency_id,platform_creator_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      ctx.scopeId,
      ctx.agencyId,
      ctx.platformCreatorId
    );
    const row = await c.one(
      db,
      "SELECT * FROM crm_scope WHERE scope_id=$1 AND agency_id=$2",
      ctx.scopeId,
      ctx.agencyId
    );
    c.check(row && row.platform_creator_id === ctx.platformCreatorId, "CRM_SCOPE_INVALID", 403);
    return row;
  }
  async ensure(ctx, fanId, db = this.db) {
    await this.scope(ctx, db);
    c.platformId(fanId);
    await c.exec(
      db,
      "INSERT INTO crm_profile(scope_id,fan_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      ctx.scopeId,
      fanId
    );
    return c.one(db, "SELECT * FROM crm_profile WHERE scope_id=$1 AND fan_id=$2", ctx.scopeId, fanId);
  }
  async receipt(ctx, id, payload) {
    c.commandId(id, { receiptReplay: true });
    const row = await c.one(
      this.db,
      "SELECT * FROM crm_command_receipt WHERE scope_id=$1 AND command_id=$2",
      ctx.scopeId,
      id
    );
    if (!row) {
      c.commandId(id);
      return null;
    }
    c.check(row.request_hash === c.hash([ctx.actorId, ctx.deviceId, payload]), "CRM_COMMAND_CONFLICT");
    return row.result;
  }
  async command(ctx, id, payload, fn) {
    c.commandId(id, { receiptReplay: true });
    const digest = c.hash([ctx.actorId, ctx.deviceId, payload]);
    return c.transaction(this.db, async (tx) => {
      await this.scope(ctx, tx);
      await c.one(tx, "SELECT scope_id FROM crm_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
      const existing = await c.one(
        tx,
        "SELECT * FROM crm_command_receipt WHERE scope_id=$1 AND command_id=$2",
        ctx.scopeId,
        id
      );
      if (existing) {
        c.check(existing.request_hash === digest, "CRM_COMMAND_CONFLICT");
        return existing.result;
      }
      c.commandId(id);
      // A retained receipt is a read of a committed outcome. Capacity only
      // admits new growth, after the scope and command fingerprint are checked.
      await this.admitGrowth();
      const result = await fn(tx);
      c.bounded(result, 16384);
      await c.exec(
        tx,
        `DELETE FROM crm_command_receipt WHERE (scope_id,command_id) IN (SELECT scope_id,command_id FROM crm_command_receipt WHERE scope_id=$1 AND expires_at<now() ORDER BY expires_at LIMIT 64)`,
        ctx.scopeId
      );
      c.check(
        !(await c.one(tx, "SELECT 1 FROM crm_command_receipt WHERE scope_id=$1 OFFSET 8192 LIMIT 1", ctx.scopeId)),
        "CRM_COMMAND_CAPACITY",
        429
      );
      await c.exec(
        tx,
        "INSERT INTO crm_command_receipt(scope_id,command_id,request_hash,result,expires_at) VALUES($1,$2,$3,$4::jsonb,now()+interval '2 days')",
        ctx.scopeId,
        id,
        digest,
        JSON.stringify(result ?? null)
      );
      return result;
    });
  }
  async touch(ctx, fanId, tx, kind, fields) {
    await c.exec(
      tx,
      "DELETE FROM crm_audit WHERE id IN (SELECT id FROM crm_audit WHERE scope_id=$1 AND created_at<now()-interval '90 days' ORDER BY created_at LIMIT 32)",
      ctx.scopeId
    );
    const scope = await c.one(
      tx,
      "UPDATE crm_scope SET revision=revision+1,updated_at=now() WHERE scope_id=$1 RETURNING revision",
      ctx.scopeId
    );
    await c.exec(
      tx,
      "INSERT INTO crm_audit(id,scope_id,fan_id,actor_id,kind,revision,fields) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
      c.randomUUID(),
      ctx.scopeId,
      fanId,
      ctx.actorId || "system",
      kind,
      scope.revision,
      JSON.stringify(fields)
    );
    return Number(scope.revision);
  }
  async readProfile(ctx, fanId) {
    c.platformId(fanId);
    return (
      (await c.one(
        this.db,
        `SELECT p.*,coalesce((SELECT jsonb_agg(n ORDER BY n.created_at,n.note_id) FROM (SELECT note_id,text,created_at FROM crm_note WHERE scope_id=p.scope_id AND fan_id=p.fan_id AND deleted=false ORDER BY created_at,note_id LIMIT 200) n),'[]'::jsonb) notes
    FROM crm_profile p WHERE scope_id=$1 AND fan_id=$2`,
        ctx.scopeId,
        fanId
      )) || { profile: {}, revision: 0, field_versions: {}, manual_fields: [], accepted_input: null, notes: [] }
    );
  }
  async getProfile(ctx, fanId) {
    const row = await this.readProfile(ctx, fanId);
    const identities = await this.identities(ctx, [fanId]);
    return currentIdentity(profileValue(row, row.notes), identities.get(fanId));
  }
  async getPanelSnapshot(ctx, input) {
    const fanId = c.platformId(input.dialogId),
      row = await this.readProfile(ctx, fanId),
      identities = await this.identities(ctx, [fanId]),
      profile = currentIdentity(profileValue(row, row.notes), identities.get(fanId));
    let history = {
        available: false,
        error: "DIALOG_HISTORY_UNAVAILABLE",
        collectionFromAt: null,
        complete: false,
        revision: null,
      },
      stats = require("./dialog-read-models").emptyCrmStats(),
      recentMessages = [],
      currentInput = null;
    try {
      const model = this.models || new (require("./dialog-read-models").DialogReadModels)(this.dialogs);
      const value = await model.panel(ctx, { dialogId: fanId, recentLimit: input.recentLimit });
      ({ history, stats, recentMessages, currentInput } = value);
    } catch (error) {
      history.error = error.code || "DIALOG_HISTORY_UNAVAILABLE";
    }
    const descriptor = row.profile?._replyInput;
    let replyFreshnessReason = "UNKNOWN_INPUT";
    if (descriptor?.replyContext?.policy === "crm-replies-context-v1" && typeof descriptor.replyContext.identityRevision === "string") {
      if (!currentInput) replyFreshnessReason = "HISTORY_UNAVAILABLE";
      else if (descriptor.epoch !== currentInput.epoch || descriptor.revision !== currentInput.revision) replyFreshnessReason = "HISTORY_CHANGED";
      else {
        // Re-read the CRM source after the authoritative history read: a panel
        // assembled across databases must not mark a changed profile as fresh.
        const current = await c.one(this.db, `SELECT p.revision,p.reply_token,p.profile->'_replyInput' AS reply_input,s.persona_revision
          FROM crm_profile p JOIN crm_scope s USING(scope_id) WHERE p.scope_id=$1 AND p.fan_id=$2`, ctx.scopeId, fanId);
        if (!current || Number(current.revision) !== descriptor.replyContext.profileRevision
          || current.reply_token !== row.reply_token || c.hash(current.reply_input) !== c.hash(descriptor)) replyFreshnessReason = "PROFILE_CHANGED";
        else if (Number(current.persona_revision) !== descriptor.replyContext.personaRevision) replyFreshnessReason = "PERSONA_CHANGED";
        else if (await this.identityToken(ctx, fanId) !== descriptor.replyContext.identityRevision) replyFreshnessReason = "IDENTITY_CHANGED";
        else replyFreshnessReason = null;
      }
    }
    const staleReplySuggestions = replyFreshnessReason === null ? [] : profile.replySuggestions;
    // Older desktops do not understand the freshness flag. Keep stale text in
    // a separate read-only field so their existing actionable list is empty.
    if (replyFreshnessReason !== null) profile.replySuggestions = [];
    return {
      ok: true,
      creatorId: ctx.creatorId,
      dialogId: fanId,
      exists: row.revision > 0 || stats.messagesCount > 0,
      profile,
      revision: profile.revision,
      recentMessages,
      stats,
      history,
      financial: { available: false, source: "financial-ledger", reason: "NOT_REQUESTED" },
      analysisFresh: !!(
        currentInput &&
        row.accepted_input &&
        row.accepted_input.epoch === currentInput.epoch &&
        row.accepted_input.revision === currentInput.revision
      ),
      repliesFresh: replyFreshnessReason === null,
      replyFreshnessReason,
      staleReplySuggestions,
    };
  }
  async updateProfile(ctx, input, id) {
    const fanId = c.platformId(input.dialogId);
    const incoming = { ...c.object(input.patch) };
    if (incoming.fanName !== undefined) {
      incoming.preferredName = incoming.fanName;
      delete incoming.fanName;
    }
    if (incoming.fanUsername !== undefined) {
      incoming.manualAlias = incoming.fanUsername;
      delete incoming.fanUsername;
    }
    delete incoming.notesManual;
    const patch = cleanPatch(incoming);
    for (const key of Object.keys(patch)) c.check(MANUAL.has(key) && !FORBIDDEN.has(key), "CRM_FIELD_READ_ONLY", 403);
    const receipt = await this.command(
      ctx,
      id,
      { kind: "profile.patch", fanId, patch, baseRevision: input.baseRevision, appendNotes: input.appendNotes || [],
        ...(input.fieldBaseRevisions === undefined ? {} : { fieldBaseRevisions: input.fieldBaseRevisions }) },
      async (tx) => {
        const before = await this.ensure(ctx, fanId, tx);
        const expected = c.integer(input.baseRevision, 0);
        c.check(input.baseRevision !== undefined, "CRM_EXPECTED_REVISION_REQUIRED", 409);
        if (expected > Number(before.revision)) return { rejected: { code: "CRM_EDIT_CONFLICT" } };
        if (input.fieldBaseRevisions !== undefined) c.check(input.fieldBaseRevisions && typeof input.fieldBaseRevisions === "object"
          && !Array.isArray(input.fieldBaseRevisions) && Object.keys(input.fieldBaseRevisions).every(key => Object.hasOwn(patch, key)), "CRM_FIELD_BASE_INVALID", 400);
        for (const key of Object.keys(patch)) {
          const fieldExpected = input.fieldBaseRevisions?.[key] ?? expected;
          c.check(Number.isSafeInteger(fieldExpected) && fieldExpected >= 0 && fieldExpected <= Number(before.revision), "CRM_FIELD_BASE_INVALID", 400);
          if (Number(before.field_versions[key] || 0) > fieldExpected) return { rejected: { code: "CRM_EDIT_CONFLICT" } };
        }
        const next = { ...before.profile, ...patch },
          manual = [...new Set([...before.manual_fields, ...Object.keys(patch)])],
          revision = Number(before.revision) + 1;
        const versions = { ...before.field_versions };
        for (const key of Object.keys(patch)) versions[key] = revision;
        validateMergedProfile(next);
        boundStoredProfile(next);
        c.check(
          Array.isArray(input.appendNotes || []) && (input.appendNotes || []).length <= editLimits.notesPerCommandMax,
          "CRM_NOTES_INVALID",
          400
        );
        for (const [index, note] of (input.appendNotes || []).entries()) {
          c.check(typeof note === "string" && note.trim().length > 0 && !note.includes("\0") && note.length <= editLimits.noteTextMax, "CRM_NOTES_INVALID", 400);
          const noteBytes = Number(
            (
              await c.one(
                tx,
                "SELECT coalesce(sum(octet_length(text)),0) bytes FROM crm_note WHERE scope_id=$1 AND fan_id=$2 AND deleted=false",
                ctx.scopeId,
                fanId
              )
            ).bytes
          );
          c.check(noteBytes + Buffer.byteLength(note) <= 65536, "CRM_NOTES_CAPACITY", 409);
          c.check(
            !(await c.one(
              tx,
              "SELECT 1 FROM crm_note WHERE scope_id=$1 AND fan_id=$2 AND deleted=false OFFSET 199 LIMIT 1",
              ctx.scopeId,
              fanId
            )),
            "CRM_NOTES_CAPACITY",
            409
          );
          await c.exec(
            tx,
            "INSERT INTO crm_note(scope_id,fan_id,note_id,text,author_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",
            ctx.scopeId,
            fanId,
            c.hash([id, index]),
            note,
            ctx.actorId
          );
        }
        await c.exec(
          tx,
          "UPDATE crm_profile SET revision=$3,profile=$4::jsonb,manual_fields=$5::jsonb,field_versions=$6::jsonb,updated_at=now() WHERE scope_id=$1 AND fan_id=$2",
          ctx.scopeId,
          fanId,
          revision,
          JSON.stringify(next),
          JSON.stringify(manual),
          JSON.stringify(versions)
        );
        await this.touch(ctx, fanId, tx, "manual.patch", Object.keys(patch));
        return { revision };
      }
    );
    // A CAS rejection is recorded under the same command/hash before returning.
    // Receipt lookup can therefore prove non-application after a lost response.
    if (receipt.rejected?.code === "CRM_EDIT_CONFLICT") throw c.fail("CRM_EDIT_CONFLICT", 409);
    return { ...await this.getPanelSnapshot(ctx, input), mutation: {
      kind: "crm.profile.update", commandId: id, committedRevision: receipt.revision,
    } };
  }
  async applyAiPatch(ctx, fanId, patch, tx) {
    const before = await this.ensure(ctx, fanId, tx);
    const values = cleanPatch(patch);
    for (const key of before.manual_fields) delete values[key];
    delete values.notesManual;
    delete values.platformUsername;
    delete values.platformDisplayName;
    if (values.fanName !== undefined) {
      values.inferredPersonalName = values.fanName;
      delete values.fanName;
    }
    delete values.fanUsername;
    const next = { ...before.profile, ...values };
    validateMergedProfile(next);
    boundStoredProfile(next);
    const revision = Number(before.revision) + 1;
    await c.exec(
      tx,
      "UPDATE crm_profile SET profile=$3::jsonb,revision=$4,updated_at=now() WHERE scope_id=$1 AND fan_id=$2",
      ctx.scopeId,
      fanId,
      JSON.stringify(next),
      revision
    );
    await this.touch(ctx, fanId, tx, "analysis.accepted", Object.keys(values));
  }
  async personaGet(ctx) {
    const scope = await this.scope(ctx);
    return {
      ok: true,
      profile: scope.persona ? { ...scope.persona, creatorId: ctx.creatorId } : null,
      revision: Number(scope.persona_revision),
    };
  }
  async personaSave(ctx, input, id) {
    const data = c.object(input.profile);
    c.check(data.creatorId === ctx.creatorId, "CRM_PERSONA_SCOPE_MISMATCH", 403);
    c.check(Buffer.byteLength(JSON.stringify(data)) <= personaLimits.maxPayloadUtf8Bytes, "CRM_PERSONA_TOO_LARGE", 413);
    for (const key of Object.keys(data))
      c.check(
        ["version", "creatorId", "personal", "chatting", "physicalContent", "createdAt", "updatedAt"].includes(key),
        "CRM_PERSONA_FIELD_UNKNOWN",
        400
      );
    for (const key of ["personal", "chatting", "physicalContent"]) {
      c.check(data[key] && typeof data[key] === "object" && !Array.isArray(data[key]), "CRM_PERSONA_INVALID", 400);
      for (const value of Object.values(data[key]))
        c.check(
          (typeof value === "string" && value.length <= personaLimits.maxStringLength) || typeof value === "boolean",
          "CRM_PERSONA_INVALID",
          400
        );
    }
    await this.command(ctx, id, { kind: "persona", data, baseRevision: input.baseRevision }, async (tx) => {
      const scope = await this.scope(ctx, tx);
      c.check(
        input.baseRevision !== undefined && Number(scope.persona_revision) === input.baseRevision,
        "CRM_EDIT_CONFLICT"
      );
      const profile = {
        ...data,
        version: 1,
        creatorId: ctx.creatorId,
        createdAt: scope.persona?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await c.exec(
        tx,
        "UPDATE crm_scope SET persona=$2::jsonb,persona_revision=persona_revision+1,revision=revision+1,updated_at=now() WHERE scope_id=$1",
        ctx.scopeId,
        JSON.stringify(profile)
      );
      return { revision: Number(scope.persona_revision) + 1 };
    });
    return this.personaGet(ctx);
  }
  async updateFanIdentity(ctx, input) {
    return c.transaction(this.db, async (tx) => {
      await this.scope(ctx, tx);
      await c.one(tx, "SELECT scope_id FROM crm_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
      const fanId = c.platformId(input.dialogId),
        p = await this.ensure(ctx, fanId, tx),
        patch = {};
      if (input.fanName && !p.profile.platformIdentityRevision)
        patch.platformDisplayName = String(input.fanName).slice(0, 240);
      if (input.fanUsername && !p.profile.platformIdentityRevision)
        patch.platformUsername = String(input.fanUsername).replace(/^@/, "").slice(0, 240);
      if (Object.keys(patch).some((key) => p.profile[key] !== patch[key])) {
        await c.exec(
          tx,
          "UPDATE crm_profile SET profile=profile || $3::jsonb,revision=revision+1,updated_at=now() WHERE scope_id=$1 AND fan_id=$2",
          ctx.scopeId,
          fanId,
          JSON.stringify(patch)
        );
        await this.touch(ctx, fanId, tx, "identity.observed", Object.keys(patch));
      }
    });
  }
  async readPage(ctx, input) {
    const identityRevision = await this.identityRevision(ctx);
    const page = await c.transaction(this.db, async (tx) => {
      await this.scope(ctx, tx);
      const scope = await c.one(tx, "SELECT * FROM crm_scope WHERE scope_id=$1 FOR SHARE", ctx.scopeId);
      const revision = this.combinedRevision(scope.revision, identityRevision);
      if (input.revision !== undefined) c.check(input.revision === revision, "CAMPAIGN_SOURCE_CHANGED");
      const fields = [
        "platformDisplayName",
        "platformUsername",
        "preferredName",
        "inferredPersonalName",
        "fanCountry",
        "fanCity",
        "nativeLanguage",
        "chatLanguage",
        "preferredTone",
        "sexualDynamic",
        "fetishes",
        "contentPreferences",
        "turnOnTriggers",
        "requestedContent",
        "boundaries",
        "negations",
        "analysisStatus",
      ];
      const projection = fields.flatMap((key) => ["'" + key + "'", "profile->'" + key + "'"]).join(",");
      const records = await c.rows(
        tx,
        `SELECT fan_id,revision,manual_fields,field_versions,updated_at,jsonb_build_object(${projection}) profile FROM crm_profile WHERE scope_id=$1 AND fan_id>$2 ORDER BY fan_id LIMIT 101`,
        ctx.scopeId,
        input.afterDialogId || ""
      );
      const more = records.length > 100;
      records.length = Math.min(100, records.length);
      for (const row of records) {
        row.profile = Object.fromEntries(Object.entries(row.profile).filter(([, v]) => v !== null));
      }
      const result = {
        rows: records.map((row) => ({
          creatorId: ctx.creatorId,
          dialogId: row.fan_id,
          fanId: row.fan_id,
          profile: profileValue(row),
          updatedAt: c.iso(row.updated_at),
        })),
        revision,
        nextDialogId: more ? records.at(-1).fan_id : null,
      };
      for (const row of result.rows) c.bounded(row, 16384);
      c.bounded(result, 2097152);
      return result;
    });
    // Cross-database canonical reads occur after releasing the CRM transaction.
    // The monotone source head fences identities as well as manual CRM edits.
    const identities = await this.identities(ctx, page.rows.map(row => row.fanId));
    c.check(await this.identityRevision(ctx) === identityRevision, "CAMPAIGN_SOURCE_CHANGED");
    for (const row of page.rows) row.profile = currentIdentity(row.profile, identities.get(row.fanId));
    c.bounded(page, 2097152);
    return page;
  }
  async receiveHistory(ctx, event) {
    return c.transaction(this.db, async (tx) => {
      await this.scope(ctx, tx);
      await c.one(tx, "SELECT scope_id FROM crm_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
      await this.ensure(ctx, event.dialogId, tx);
      const p = await c.one(
        tx,
        "SELECT * FROM crm_profile WHERE scope_id=$1 AND fan_id=$2 FOR UPDATE",
        ctx.scopeId,
        event.dialogId
      );
      if (p.history_epoch === event.epoch && Number(p.history_revision) >= event.revision) return { duplicate: true };
      await c.exec(
        tx,
        "UPDATE crm_profile SET history_epoch=$3,history_revision=$4,rewrite_revision=$5 WHERE scope_id=$1 AND fan_id=$2",
        ctx.scopeId,
        event.dialogId,
        event.epoch,
        event.revision,
        event.rewriteRevision
      );
      // A delayed event may arrive after analysis already accepted this exact
      // authoritative history. Advance the mirror without requeueing that same
      // input or changing the generation of a separately requested run.
      if (p.accepted_input?.epoch === event.epoch && Number(p.accepted_input.revision) >= event.revision)
        return { duplicate: false };
      await c.exec(
        tx,
        `UPDATE crm_analysis_work w SET generation=generation+CASE WHEN state='RUNNING' AND EXISTS(SELECT 1 FROM crm_analysis_run r WHERE r.run_id=w.active_run_id AND r.input->>'epoch'=$3 AND (r.input->>'revision')::bigint>=$4) THEN 0 ELSE 1 END,
        state=CASE WHEN state='RUNNING' THEN state ELSE 'READY' END,next_run_at=now(),last_error='' WHERE scope_id=$1 AND fan_id=$2 AND state IN ('DONE','READY','RUNNING')`,
        ctx.scopeId,
        event.dialogId,
        event.epoch,
        event.rewriteRevision
      );
      return { duplicate: false };
    });
  }
}
module.exports = { CrmRepository, profileValue, cleanPatch, currentIdentity };
