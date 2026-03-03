export type ProfileExtras = Record<string, any>;

export const getProfileExtras = async (prisma: any, userId?: string | null) => {
  if (!userId) return {};
  const record = await prisma.userProfile.findUnique({
    where: { userId },
    select: { data: true },
  });
  return (record?.data as ProfileExtras) || {};
};

export const getProfileExtrasMap = async (prisma: any, userIds: string[]) => {
  const map = new Map<string, ProfileExtras>();
  const ids = Array.from(new Set(userIds)).filter(Boolean);
  if (ids.length === 0) return map;
  const records = await prisma.userProfile.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, data: true },
  });
  records.forEach((record) => {
    map.set(record.userId, (record.data as ProfileExtras) || {});
  });
  return map;
};

export const mergeProfileExtras = async (
  prisma: any,
  userId: string,
  payload: ProfileExtras,
) => {
  if (!userId) return {};
  const current = await prisma.userProfile.findUnique({
    where: { userId },
    select: { data: true },
  });
  const base = (current?.data as ProfileExtras) || {};
  const cleaned = Object.fromEntries(
    Object.entries(payload || {}).filter(([, value]) => value !== undefined),
  );
  const next = { ...base, ...cleaned };
  await prisma.userProfile.upsert({
    where: { userId },
    create: { userId, data: next },
    update: { data: next },
  });
  return next;
};
