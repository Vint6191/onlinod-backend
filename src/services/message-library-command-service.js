"use strict";
const { z } = require("zod");
const { digest } = require("./team-command-contract");
const { runRootCommit } = require("./db-commit-kernel");
const {
  lockContentScope,
  lockMessageLibraryScript,
  withMessageLibraryMutation,
  changeMessageLibraryLifecycle,
} = require("./message-library-lifecycle-service");
const { assertManagementCommitAuthority } = require("./management-commit-authority-service");
const { withProductBilling } = require("./product-billing-context-service");
const ACTIONS = ["save", "duplicate", "trash", "restore", "permanent", "block.trash", "block.restore"];
const schema = z
  .object({
    commandId: z
      .string()
      .uuid()
      .transform((s) => s.toLowerCase()),
    action: z.enum(ACTIONS),
    targetId: z.string().trim().min(1).max(120),
    payload: z.record(z.unknown()),
  })
  .strict();
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
function parseCommand(input, { cancel = false } = {}) {
  // Cancellation validates the durable envelope, not the rejected business
  // payload. Otherwise a validation error could poison a Desktop pending slot.
  const command = (cancel ? schema.extend({ targetId: z.string().trim().max(180) }) : schema).parse(input);
  if (Buffer.byteLength(JSON.stringify(command.payload)) > 2 * 1024 * 1024)
    throw fail("MESSAGE_LIBRARY_COMMAND_TOO_LARGE", "Command payload exceeds 2 MiB", 413);
  if (cancel) return { ...command, creatorId: typeof command.payload.creatorId === "string" ? command.payload.creatorId.trim().slice(0, 100) : "",
    fingerprint: digest([3, command.action, command.targetId, command.payload]) };

  const creatorId = z.string().trim().min(1).max(100).parse(command.payload.creatorId);
  const allowed =
    command.action === "duplicate" ? ["creatorId", "title"] : ["creatorId", "messageId", "expectedUpdatedAt"];
  if (command.action !== "save" && Object.keys(command.payload).some((key) => !allowed.includes(key)))
    throw fail("MESSAGE_LIBRARY_COMMAND_PAYLOAD_INVALID", "Unexpected command field", 400);
  if (command.payload.title !== undefined && command.action === "duplicate")
    z.string().trim().min(1).max(180).parse(command.payload.title);
  if (command.payload.expectedUpdatedAt !== undefined)
    z.string().datetime({ offset: true }).parse(command.payload.expectedUpdatedAt);
  if (command.action.startsWith("block.")) z.string().trim().min(1).max(120).parse(command.payload.messageId);
  else if (command.payload.messageId !== undefined)
    throw fail("MESSAGE_LIBRARY_COMMAND_PAYLOAD_INVALID", "Message target requires a message action", 400);
  if (command.action === "save" && command.payload.id !== undefined && command.payload.id !== command.targetId)
    throw fail("MESSAGE_LIBRARY_COMMAND_TARGET_MISMATCH", "Script identities disagree", 400);
  if (Buffer.byteLength(JSON.stringify(command.payload)) > 2 * 1024 * 1024)
    throw fail("MESSAGE_LIBRARY_COMMAND_TOO_LARGE", "Command payload exceeds 2 MiB", 413);
  return { ...command, creatorId, fingerprint: digest([3, command.action, command.targetId, command.payload]) };
}
async function executeMessageLibraryCommand({
  db,
  agencyId,
  userId,
  actorMember,
  input,
  cancel = false,
  saveScript,
  projectScript,
  projectBlock,
}) {
  if (!agencyId || !userId || !actorMember)
    throw fail("MESSAGE_LIBRARY_ACTOR_REQUIRED", "Current membership is required", 401);
  const c = parseCommand(input, { cancel }),
    id = "ml_command_v3_" + digest([agencyId, userId, c.commandId]);
  const run = () =>
    runRootCommit(
      db,
      async (context) => {
        const tx = context.tx;
        if (cancel) await assertManagementCommitAuthority({ tx, agencyId, actorMember: { ...actorMember, userId } });
        else await lockContentScope({ tx, agencyId, creatorId: c.creatorId, actorMember, userId });
        await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", id);
        const [prior] = await tx.$queryRawUnsafe('SELECT * FROM "MessageLibraryCommandReceipt" WHERE "id"=$1', id);
        if (prior && prior.fingerprint !== c.fingerprint)
          throw fail("MESSAGE_LIBRARY_COMMAND_CONFLICT", "Command ID belongs to another intent");
        const store = async (status, result) => {
          const encoded = JSON.stringify(result);
          if (Buffer.byteLength(encoded) > 4 * 1024 * 1024)
            throw fail("MESSAGE_LIBRARY_COMMAND_RESULT_LIMIT", "Command result exceeds 4 MiB", 413);
          await tx.$executeRawUnsafe(
            `INSERT INTO "MessageLibraryCommandReceipt" ("id","agencyId","userId","creatorId","fingerprint","status","result") VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            id,
            agencyId,
            userId,
            c.creatorId,
            c.fingerprint,
            status,
            encoded
          );
        };
        if (cancel) {
          if (!prior) await store("ABANDONED", {});
          return {
            ok: true,
            commandId: c.commandId,
            alreadyCommitted: prior?.status === "COMMITTED",
            abandoned: !prior || prior.status === "ABANDONED",
          };
        }
        if (prior) {
          if (prior.status === "ABANDONED")
            throw fail("MESSAGE_LIBRARY_COMMAND_ABANDONED", "This command was cancelled");
          const result = { ...prior.result, commandId: c.commandId, replayed: true };
          const ref = result.resultReference;
          // Receipts retain only a locator and content digest. Permanent cleanup must
          // not leave a second durable copy of message text or media in receipts.
          // Resolve the committed server identity, not a newer object that may
          // reuse the client ID after cleanup, even in another creator scope.
          let row = null;
          if (ref) {
            await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", `message-library:${agencyId}:${ref.scriptId}`);
            await tx.$queryRawUnsafe('SELECT "id" FROM "ContentCollection" WHERE "id"=$1 AND "agencyId"=$2 AND "creatorId"=$3 FOR UPDATE', ref.scriptServerId, agencyId, c.creatorId);
            row = await tx.contentCollection.findFirst({ where: { id: ref.scriptServerId, agencyId, creatorId: c.creatorId, clientId: ref.scriptId, kind: "message_library_script" } });
          }
          let value = null;
          if (row && row.id === ref.scriptServerId) {
            if (ref.blockServerId && !row.deletedAt && row.status === "active") {
              const block = await tx.contentBlock.findFirst({ where: { id: ref.blockServerId, collectionId: row.id } });
              if (block) value = projectBlock(block);
            } else if (!ref.blockServerId) {
              if (["save", "duplicate"].includes(c.action)) {
                const blocks = await tx.contentBlock.findMany({
                  where: { collectionId: row.id, deletedAt: null, status: { notIn: ["trash", "deleted"] } },
                  orderBy: [{ order: "asc" }, { id: "asc" }],
                  take: 501,
                });
                if (blocks.length <= 500) value = projectScript({ ...row, blocks });
              } else value = projectScript(row);
            }
          }
          const current =
            value &&
            Buffer.byteLength(JSON.stringify(value)) <= 4 * 1024 * 1024 &&
            digest(JSON.parse(JSON.stringify(value))) === ref.resultDigest;
          return {
            ...result,
            [ref?.blockServerId ? "block" : "item"]: current ? value : null,
            ...(!current ? { resultUnavailable: true } : {}),
          };
        }
        let result;
        if (c.action === "save") {
          result = {
            ok: true,
            source: "server",
            item: projectScript(await saveScript({ ...c.payload, id: c.targetId, creatorId: c.creatorId }, tx)),
          };
        } else if (c.action === "duplicate") {
          const targetId = `copy_${c.commandId}`;
          if (targetId === c.targetId)
            throw fail("MESSAGE_LIBRARY_COMMAND_TARGET_MISMATCH", "Copy target must differ from source", 400);
          let source;
          // Both namespace locks have one order, including if a caller deliberately
          // chooses a source ID resembling another pending copy ID.
          for (const scriptId of [c.targetId, targetId].sort()) {
            const row = await lockMessageLibraryScript({ tx, agencyId, creatorId: c.creatorId, scriptId });
            if (scriptId === c.targetId) source = row;
            else if (row) throw fail("MESSAGE_LIBRARY_COPY_TARGET_EXISTS", "Copy target already exists");
          }
          if (!source || source.status === "deleting")
            throw fail("MESSAGE_LIBRARY_SCRIPT_NOT_FOUND", "Source script is unavailable", 404);
          const blocks = await tx.contentBlock.findMany({
            where: { collectionId: source.id, deletedAt: null, status: { notIn: ["trash", "deleted"] } },
            orderBy: [{ order: "asc" }, { id: "asc" }],
            take: 501,
          });
          if (blocks.length > 500)
            throw fail("MESSAGE_LIBRARY_SCRIPT_LIMIT", "Source has more than 500 active messages", 413);
          const original = projectScript({ ...source, blocks });
          const clone = {
            ...original,
            id: targetId,
            serverId: null,
            creatorId: c.creatorId,
            accountId: c.creatorId,
            title: String(c.payload.title || `${original.title} copy`).slice(0, 180),
            status: "active",
            enabled: true,
            trashedAt: null,
            purgeAfter: null,
            updatedAt: null,
            createdAt: null,
            messages: original.messages.map((block, i) => ({
              ...block,
              id: `copy_${c.commandId}_${i}`,
              serverId: null,
              status: "active",
              trashedAt: null,
              purgeAfter: null,
              updatedAt: null,
              createdAt: null,
            })),
          };
          // The existing save owner checks all media provenance inside this same
          // transaction. Copy never bypasses the GENERAL/CUSTOM fence.
          result = { ok: true, source: "server", item: projectScript(await saveScript(clone, tx)) };
        } else {
          const action = c.action.replace("block.", "");
          const changed = await withMessageLibraryMutation({
            db: tx,
            agencyId,
            creatorId: c.creatorId,
            actorMember,
            userId,
            scriptId: c.targetId,
            action,
            expectedUpdatedAt: c.payload.expectedUpdatedAt || null,
            work: (input) =>
              changeMessageLibraryLifecycle({
                ...input,
                action,
                userId,
                messageId: c.payload.messageId || null,
                includeBlocks: false,
              }),
          });
          // Lifecycle receipts describe the transition; the ordinary list read owns
          // script content. Do not serialize every historical trashed block here.
          result = {
            ok: true,
            source: "server",
            retentionDays: 14,
            ...changed,
            ...(changed.item ? { item: projectScript(changed.item) } : {}),
            ...(changed.block ? { block: projectBlock(changed.block) } : {}),
          };
        }
        const encoded = JSON.stringify(result);
        if (Buffer.byteLength(encoded) > 4 * 1024 * 1024)
          throw fail("MESSAGE_LIBRARY_COMMAND_RESULT_LIMIT", "Command result exceeds 4 MiB", 413);
        const stable = JSON.parse(encoded);
        const scriptId = c.action === "duplicate" ? `copy_${c.commandId}` : c.targetId;
        const row = await lockMessageLibraryScript({ tx, agencyId, creatorId: c.creatorId, scriptId });
        const value = stable.block || stable.item;
        const resultReference = {
          scriptId,
          scriptServerId: row.id,
          resultDigest: digest(value),
          ...(stable.block ? { blockServerId: stable.block.serverId } : {}),
        };
        const { item: omittedItem, block: omittedBlock, ...metadata } = stable;
        await store("COMMITTED", { ...metadata, resultReference });
        return { ...stable, resultReference, commandId: c.commandId, replayed: false };
      },
      { profile: "COMMAND", authority: { kind: "MESSAGE_LIBRARY_COMMAND", agencyId, userId }, maxAttempts: 1 }
    );
  // Explicit retries reuse the durable ID. Existing callbacks were not silently
  // opted into automatic root replay; the default remains one DB attempt.
  return cancel ? run() : withProductBilling(agencyId, run);
}
module.exports = { parseCommand, executeMessageLibraryCommand, ACTIONS };
