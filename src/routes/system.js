const express = require("express");
const crypto = require("node:crypto");

const router = express.Router();

const MAX_RULES_BYTES = Number(process.env.RULES_MAX_BYTES || 5 * 1024 * 1024);
const DEFAULT_RULES_SOURCE_URL = "https://raw.githubusercontent.com/Vint6191/onlyfans-deob/main/dynamic-rules.json";

function hmacSignature(body) {
  const secret = process.env.ONLINOD_RULES_HMAC_SECRET || process.env.RULES_HMAC_SECRET || "";
  if (!secret) return null;
  return `sha256=${crypto.createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

function resolveRulesSourceUrl() {
  return String(
    process.env.ONLINOD_RULES_SOURCE_URL ||
      process.env.RULES_SOURCE_URL ||
      DEFAULT_RULES_SOURCE_URL
  ).trim();
}

router.get("/dynamic-rules", async (_req, res) => {
  const sourceUrl = resolveRulesSourceUrl();
  if (!sourceUrl) {
    return res.status(503).json({
      ok: false,
      code: "RULES_SOURCE_NOT_CONFIGURED",
      error: "Dynamic rules source is not configured",
    });
  }

  try {
    const response = await fetch(sourceUrl, {
      headers: {
        Accept: "application/json",
        "User-Agent": "onlinod-rules-proxy/1.0",
        "Cache-Control": "no-cache",
      },
    });

    if (!response.ok) {
      return res.status(502).json({
        ok: false,
        code: "RULES_SOURCE_HTTP_ERROR",
        error: `Rules source returned HTTP ${response.status}`,
      });
    }

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength && contentLength > MAX_RULES_BYTES) {
      return res.status(413).json({ ok: false, code: "RULES_TOO_LARGE", error: "Rules payload is too large" });
    }

    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_RULES_BYTES) {
      return res.status(413).json({ ok: false, code: "RULES_TOO_LARGE", error: "Rules payload is too large" });
    }

    // Validate that backend never signs garbage.
    JSON.parse(raw);

    const signature = hmacSignature(raw);
    if (signature) res.setHeader("X-Onlinod-Rules-Signature", signature);
    res.setHeader("X-Onlinod-Rules-Source", "github-public-default");
    res.setHeader("Cache-Control", "no-store");
    res.type("application/json").send(raw);
  } catch (err) {
    console.error("[system/dynamic-rules] failed:", err?.message || err);
    return res.status(502).json({ ok: false, code: "RULES_PROXY_FAILED", error: "Failed to fetch dynamic rules" });
  }
});

module.exports = router;
