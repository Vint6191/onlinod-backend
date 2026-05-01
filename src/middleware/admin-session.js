const crypto = require("node:crypto");
const prisma = require("../prisma");

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function readBearer(req) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

async function adminSessionRequired(req, res, next) {
  try {
    const token = readBearer(req);
    if (!token) {
      return res.status(401).json({ ok: false, code: "ADMIN_AUTH_REQUIRED", error: "Admin authorization token is required" });
    }

    const session = await prisma.adminSession.findUnique({
      where: { tokenHash: sha256(token) },
      include: { adminUser: true },
    });

    if (!session || session.revokedAt || session.expiresAt < new Date()) {
      return res.status(401).json({ ok: false, code: "ADMIN_AUTH_INVALID", error: "Invalid or expired admin session" });
    }

    if (!session.adminUser?.active) {
      return res.status(403).json({ ok: false, code: "ADMIN_DISABLED", error: "Admin user is disabled" });
    }

    req.admin = session.adminUser;
    req.adminSession = session;
    return next();
  } catch (err) {
    console.error("[adminSessionRequired] failed:", err);
    return res.status(500).json({ ok: false, code: "ADMIN_AUTH_FAILED", error: "Admin auth failed" });
  }
}

module.exports = { adminSessionRequired };
