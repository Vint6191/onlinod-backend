const bcrypt = require("bcryptjs");
const prisma = require("../src/prisma");

async function main() {
  const email = String(process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || "");
  const name = String(process.env.ADMIN_NAME || "Onlinod Admin").trim();

  if (!email || !password) {
    console.error("Usage: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='strong-password' node scripts/create-admin-user.js");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("ADMIN_PASSWORD must be at least 8 characters");
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await prisma.adminUser.upsert({
    where: { email },
    create: { email, passwordHash, name, role: "SUPER_ADMIN", active: true },
    update: { passwordHash, name, role: "SUPER_ADMIN", active: true },
  });
  console.log("Admin user ready:", { id: admin.id, email: admin.email, role: admin.role, active: admin.active });
}

main().catch((err) => { console.error(err); process.exit(1); }).finally(async () => prisma.$disconnect());
