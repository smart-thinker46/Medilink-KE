const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient();

const stripAdminId = (data) => {
  if (!data || typeof data !== "object") return { next: data, changed: false };
  const next = { ...data };
  let changed = false;
  ["adminId", "adminIdUrl", "adminIdName"].forEach((key) => {
    if (key in next) {
      delete next[key];
      changed = true;
    }
  });
  return { next, changed };
};

async function main() {
  const users = await prisma.user.findMany({
    where: { role: "PHARMACY_ADMIN" },
    select: { id: true, email: true },
  });

  if (!users.length) {
    console.log("No pharmacy admins found.");
    return;
  }

  const profiles = await prisma.userProfile.findMany({
    where: { userId: { in: users.map((user) => user.id) } },
    select: { userId: true, data: true },
  });

  let updated = 0;
  let scanned = 0;

  for (const profile of profiles) {
    scanned += 1;
    const { next, changed } = stripAdminId(profile.data);
    if (!changed) continue;
    await prisma.userProfile.update({
      where: { userId: profile.userId },
      data: { data: next },
    });
    updated += 1;
  }

  console.log(
    `Scanned ${scanned} pharmacy profiles. Cleaned adminId fields on ${updated} profile(s).`,
  );
}

main()
  .catch((error) => {
    console.error("Cleanup failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
