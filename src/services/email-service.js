const { Resend } = require("resend");

function getAppUrl() {
  return (process.env.APP_URL || process.env.PUBLIC_BASE_URL || "http://localhost:10000").replace(/\/+$/, "");
}

function getFrom() {
  return process.env.EMAIL_FROM || "Onlinod <onboarding@resend.dev>";
}

function getResendClient() {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  return new Resend(key);
}

async function sendMail({ to, subject, html, text }) {
  const resend = getResendClient();

  if (!resend) {
    console.warn("[email] RESEND_API_KEY missing. Email not sent.");
    console.warn("[email] to:", to);
    console.warn("[email] subject:", subject);
    console.warn("[email] text:", text);
    return { ok: true, skipped: true };
  }

  try {
    const result = await resend.emails.send({
      from: getFrom(),
      to,
      subject,
      html,
      text,
    });

    return { ok: true, result };
  } catch (err) {
    console.error("[email] send failed:", err);
    return {
      ok: false,
      error: String(err?.message || err),
    };
  }
}

function verificationEmail({ email, token, code }) {
  const base = getAppUrl();
  const verifyUrl = `${base}/api/auth/verify-email?token=${encodeURIComponent(token)}`;

  return sendMail({
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
  }).then((result) => ({
    ...result,
    verifyUrl,
  }));
}

function passwordResetEmail({ email, token }) {
  const base = getAppUrl();
  const resetUrl = `${base}/reset-password?token=${encodeURIComponent(token)}`;

  return sendMail({
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
  }).then((result) => ({
    ...result,
    resetUrl,
  }));
}

module.exports = {
  sendMail,
  verificationEmail,
  passwordResetEmail,
};
