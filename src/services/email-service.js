
function getAppUrl() {
  return (process.env.APP_URL || process.env.PUBLIC_BASE_URL || "http://localhost:10000").replace(/\/+$/, "");
}

function getFrom() {
  return process.env.EMAIL_FROM || "Onlinod <onboarding@resend.dev>";
}

async function sendMail(payload, { idempotencyKey, fetchImpl = globalThis.fetch } = {}) {
  if (!process.env.RESEND_API_KEY) return { ok: false, code: "EMAIL_NOT_CONFIGURED", outcome: "not_started" };
  if (!idempotencyKey || idempotencyKey.length > 256) throw new Error("EMAIL_IDENTITY_REQUIRED");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000); timer.unref?.();
  let reader;
  try {
    const response = await fetchImpl("https://api.resend.com/emails", {
      method: "POST", headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload), signal: controller.signal, redirect: "error",
    });
    if (!response.ok) return { ok: false, code: `EMAIL_HTTP_${response.status}`, outcome: response.status >= 500 || [408,409,429].includes(response.status) ? "unknown" : "rejected" };
    reader = response.body?.getReader(); if (!reader) return { ok: false, code: "EMAIL_RESPONSE_INVALID", outcome: "unknown" };
    let size = 0; const chunks = [];
    for (;;) { const {done,value} = await reader.read(); if (done) break; size += value.byteLength; if (size > 16 * 1024) throw new Error("EMAIL_RESPONSE_TOO_LARGE"); chunks.push(Buffer.from(value)); }
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (typeof result?.id !== "string" || !result.id || result.id.length > 180) return { ok: false, code: "EMAIL_RESPONSE_INVALID", outcome: "unknown" };
    return { ok: true, providerId: result.id, outcome: "confirmed" };
  } catch (_) { return { ok: false, code: controller.signal.aborted ? "EMAIL_TIMEOUT" : "EMAIL_TRANSPORT_UNKNOWN", outcome: "unknown" }; }
  finally { controller.abort(); clearTimeout(timer); try { await reader?.cancel(); } catch (_) {} }
}

function verificationPayload({ email, token, code }) {
  const base = getAppUrl();
  const verifyUrl = `${base}/api/auth/verify-email?token=${encodeURIComponent(token)}`;

  return {
    from: getFrom(),
    to: email,
    subject: "Verify your Onlinod email",
    text:
      `Welcome to Onlinod.\n\n` +
      `Verify your email by opening this link:\n${verifyUrl}\n\n` +
      `Or use this code: ${code}\n\n` +
      `This link expires in 30 minutes.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
        <h2>Verify your Onlinod email</h2>
        <p>Welcome to Onlinod.</p>
        <p><a href="${verifyUrl}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:8px">Verify email</a></p>
        <p>Or use this code:</p>
        <div style="font-size:24px;font-weight:700;letter-spacing:4px">${code}</div>
        <p style="color:#666">This link expires in 30 minutes.</p>
      </div>
    `,
  };
}

function passwordResetPayload({ email, token }) {
  const base = getAppUrl();
  const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;

  return {
    from: getFrom(),
    to: email,
    subject: "Reset your Onlinod password",
    text:
      `Reset your Onlinod password:\n${resetUrl}\n\n` +
      `This link expires in 30 minutes. If you did not request this, ignore this email.`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111">
        <h2>Reset your Onlinod password</h2>
        <p><a href="${resetUrl}" style="display:inline-block;padding:10px 14px;background:#111;color:#fff;text-decoration:none;border-radius:8px">Reset password</a></p>
        <p style="color:#666">This link expires in 30 minutes. If you did not request this, ignore this email.</p>
      </div>
    `,
  };
}

module.exports = {
  sendMail,
  verificationPayload,
  passwordResetPayload,
};
