"use strict";
const router = require("express").Router();
const prisma = require("../prisma");
// Avatars were already public under /uploads. Only immutable validated raster
// bytes are served here; no arbitrary file path or storage credential is exposed.
router.get("/avatars/:id", async (req, res) => {
  if (!/^[a-f0-9]{64}$/.test(req.params.id)) return res.sendStatus(404);
  try {
    const row = await prisma.avatarAsset.findUnique({ where: { id: req.params.id } });
    if (!row) return res.sendStatus(404);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("ETag", `"${row.id}"`);
    return res.type(row.mimeType).send(Buffer.from(row.bytes));
  } catch (_) {
    return res.sendStatus(503);
  }
});
module.exports = router;
