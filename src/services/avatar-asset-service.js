"use strict";
const { createHash } = require("node:crypto");
const { fail } = require("./management-command-contract");
const { authorizeCreatorAccountWrite } = require("./phase2-release-compatibility-authority-service");
function avatarBytes(payload) {
  if (payload.dataBase64 === null) return null;
  const text = payload.dataBase64;
  if (typeof text !== "string" || text.length > 4 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(text))
    throw fail("AVATAR_INVALID", "Invalid avatar", 400);
  const bytes = Buffer.from(text, "base64");
  if (!bytes.length || bytes.length > 3 * 1024 * 1024 || bytes.toString("base64") !== text)
    throw fail("AVATAR_INVALID", "Invalid avatar", 400);
  const mime = payload.mimeType;
  const valid =
    mime === "image/jpeg"
      ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : mime === "image/png"
        ? bytes.subarray(0, 8).toString("hex") === "89504e470d0a1a0a"
        : mime === "image/webp" &&
          bytes.subarray(0, 4).toString() === "RIFF" &&
          bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw fail("AVATAR_INVALID", "Avatar content does not match its image type", 400);
  return bytes;
}
function assetUrl(id) {
  const base = (
    process.env.PUBLIC_BASE_URL ||
    process.env.API_PUBLIC_URL ||
    process.env.APP_URL ||
    (process.env.NODE_ENV !== "production" ? "http://localhost:10000" : "")
  ).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw fail("AVATAR_PUBLIC_BASE_REQUIRED", "Public API URL must be configured", 503);
  return `${base}/api/assets/avatars/${id}`;
}
async function applyAvatar(tx, { agencyId, userId, creatorId, payload }) {
  const owner = creatorId
    ? await tx.creatorAccount.findFirst({ where: { id: creatorId, agencyId, deletedAt: null } })
    : await tx.user.findUnique({ where: { id: userId } });
  if (!owner || owner.avatarRevision !== payload.expectedRevision)
    throw fail("AVATAR_REVISION_CHANGED", "Profile photo changed; refresh before editing");
  const bytes = avatarBytes(payload);
  let avatarUrl = null;
  if (bytes) {
    const id = createHash("sha256").update(payload.mimeType).update("\0").update(bytes).digest("hex");
    await tx.$executeRawUnsafe(
      'INSERT INTO "AvatarAsset" ("id","mimeType","bytes") VALUES ($1,$2,$3) ON CONFLICT ("id") DO NOTHING',
      id,
      payload.mimeType,
      bytes
    );
    avatarUrl = assetUrl(id);
  }
  // Asset, pointer, revision and command receipt share the root transaction.
  // Old public assets are retained for Phase 7; there is no cross-replica unlink.
  const data = { avatarUrl, avatarRevision: { increment: 1 } };
  if (creatorId) {
    await authorizeCreatorAccountWrite(tx);
    return { creator: await tx.creatorAccount.update({ where: { id: creatorId }, data }) };
  }
  return { user: await tx.user.update({ where: { id: userId }, data }) };
}
module.exports = { avatarBytes, assetUrl, applyAvatar };
