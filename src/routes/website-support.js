"use strict";
const router = require("express").Router();
const multer = require("multer");
const { z } = require("zod");
const { sendMail, getFrom } = require("../services/email-service");
const { websiteConfig } = require("../services/website-config-service");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 3, fields: 9, fieldSize: 10_000 } }).array("files", 3);
const inputSchema = z.object({ requestId: z.string().uuid(), name: z.string().trim().max(80).optional(),
  email: z.string().trim().email().max(254), topic: z.enum(["installation", "access", "billing", "bug", "idea", "other"]),
  message: z.string().trim().min(10).max(8000), os: z.string().trim().max(80).optional(), version: z.string().trim().max(40).optional() }).strict();
function safeAttachment(file) {
  const b = file.buffer;
  const ext = String(file.originalname).split(".").pop().toLowerCase();
  const valid = (ext === "png" && b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) ||
    (["jpg", "jpeg"].includes(ext) && b[0] === 255 && b[1] === 216 && b[2] === 255) ||
    (ext === "webp" && b.subarray(0, 4).toString() === "RIFF" && b.subarray(8, 12).toString() === "WEBP") ||
    (["txt", "log"].includes(ext) && !b.includes(0));
  if (!valid) throw Object.assign(new Error("Unsupported attachment"), { code: "SUPPORT_FILE_INVALID", status: 400 });
  return { filename: String(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100), content: b.toString("base64") };
}
router.post("/", (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!websiteConfig().support.available) return res.status(503).json({ ok: false, code: "SUPPORT_UNAVAILABLE", error: "Support delivery is not configured" });
  upload(req, res, async error => {
    if (error) return res.status(400).json({ ok: false, code: "SUPPORT_FILE_LIMIT", error: "Up to three files, 5 MB each" });
    try {
      const input = inputSchema.parse(req.body);
      const payload = { from: getFrom(), to: process.env.SUPPORT_EMAIL,
        reply_to: input.email, subject: `NOD support · ${input.topic} · ${input.requestId}`,
        text: [`Request: ${input.requestId}`, `From: ${input.name || "—"} <${input.email}>`, `Topic: ${input.topic}`,
          `System: ${input.os || "—"}`, `Version: ${input.version || "—"}`, "", input.message].join("\n"),
        attachments: (req.files || []).map(safeAttachment) };
      const result = await sendMail(payload, { idempotencyKey: `nod-support/${input.requestId}` });
      if (result.ok) return res.status(201).json({ ok: true, requestId: input.requestId, status: "ACCEPTED" });
      return res.status(result.outcome === "unknown" ? 504 : 503).json({ ok: false, requestId: input.requestId,
        code: result.outcome === "unknown" ? "SUPPORT_DELIVERY_UNKNOWN" : "SUPPORT_DELIVERY_FAILED",
        error: "Delivery could not be confirmed. Retry the same request." });
    } catch (err) {
      return res.status(err.status || 400).json({ ok: false, code: err.code || "SUPPORT_INPUT_INVALID", error: "Check the form and attachments" });
    }
  });
});
module.exports = router;
