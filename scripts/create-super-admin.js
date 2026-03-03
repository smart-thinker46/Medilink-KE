#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcrypt");
const { PrismaClient } = require("@prisma/client");

const args = process.argv.slice(2);
const getArg = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const envPath = path.resolve(__dirname, "..", ".env");
if (!process.env.DATABASE_URL && fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, "utf8");
  envContent.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim().replace(/^"|"$/g, "");
    if (!process.env[key]) process.env[key] = value;
  });
}

const email = (getArg("--email") || "").trim().toLowerCase();
const password = getArg("--password") || "";
const fullName = getArg("--name") || "Super Admin";
const phone = getArg("--phone") || null;

if (!email || !password) {
  console.log("Usage: node scripts/create-super-admin.js --email you@example.com --password StrongPass123!");
  process.exit(1);
}

const prisma = new PrismaClient();

async function main() {
  const hashed = await bcrypt.hash(password, 10);

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    const updated = await prisma.user.update({
      where: { email },
      data: {
        role: "SUPER_ADMIN",
        fullName: existing.fullName || fullName,
        phone: existing.phone || phone || undefined,
        password: existing.password || hashed,
        isEmailVerified: true,
      },
    });
    await prisma.systemAdmin.upsert({
      where: { userId: updated.id },
      update: {},
      create: { userId: updated.id },
    });
    console.log(`Updated user to SUPER_ADMIN: ${updated.email}`);
    return;
  }

  const user = await prisma.user.create({
    data: {
      email,
      password: hashed,
      role: "SUPER_ADMIN",
      fullName,
      phone: phone || undefined,
      isEmailVerified: true,
    },
  });

  await prisma.systemAdmin.create({
    data: { userId: user.id },
  });

  console.log(`Created SUPER_ADMIN: ${user.email}`);
}

main()
  .catch((error) => {
    console.error("Failed to create super admin:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
