import { PrismaService } from 'src/database/prisma.service';

export const DEFAULT_SUBSCRIPTION_PRICING: Record<
  string,
  { monthly: number; yearly: number }
> = {
  MEDIC: { monthly: 300, yearly: 4800 },
  PHARMACY_ADMIN: { monthly: 500, yearly: 10000 },
  HOSPITAL_ADMIN: { monthly: 1000, yearly: 12000 },
  PATIENT: { monthly: 0, yearly: 0 },
};

const SUPPORTED_PRICING_ROLES = Object.keys(DEFAULT_SUBSCRIPTION_PRICING);

const toNonNegativeInt = (value: unknown, fallback: number) => {
  const next = Number(value);
  if (!Number.isFinite(next)) return Math.max(0, Math.floor(fallback));
  return Math.max(0, Math.floor(next));
};

export const buildSubscriptionPricingMap = (rows: any[] = []) => {
  const pricing = { ...DEFAULT_SUBSCRIPTION_PRICING };
  rows.forEach((row) => {
    const role = String(row?.role || '').toUpperCase();
    if (!SUPPORTED_PRICING_ROLES.includes(role)) return;
    const current = pricing[role] || { monthly: 0, yearly: 0 };
    pricing[role] = {
      monthly: toNonNegativeInt(row?.monthly, current.monthly),
      yearly: toNonNegativeInt(row?.yearly, current.yearly),
    };
  });
  return pricing;
};

const normalizePricingPayload = (payload: Record<string, any> = {}) => {
  const normalized: Record<string, { monthly: number; yearly: number }> = {};
  SUPPORTED_PRICING_ROLES.forEach((role) => {
    if (!payload || payload[role] === undefined || payload[role] === null) return;
    const current = DEFAULT_SUBSCRIPTION_PRICING[role] || { monthly: 0, yearly: 0 };
    normalized[role] = {
      monthly: toNonNegativeInt(payload?.[role]?.monthly, current.monthly),
      yearly: toNonNegativeInt(payload?.[role]?.yearly, current.yearly),
    };
  });
  return normalized;
};

export async function getSubscriptionPricingPersistent(prisma: PrismaService) {
  const db = prisma as any;
  const rows = await db.subscriptionPricing.findMany();
  if (!rows.length) {
    await db.subscriptionPricing.createMany({
      data: SUPPORTED_PRICING_ROLES.map((role) => ({
        role,
        monthly: DEFAULT_SUBSCRIPTION_PRICING[role].monthly,
        yearly: DEFAULT_SUBSCRIPTION_PRICING[role].yearly,
      })),
      skipDuplicates: true,
    });
    const seeded = await db.subscriptionPricing.findMany();
    return buildSubscriptionPricingMap(seeded);
  }
  return buildSubscriptionPricingMap(rows);
}

export async function updateSubscriptionPricingPersistent(
  prisma: PrismaService,
  payload: Record<string, any> = {},
) {
  const db = prisma as any;
  const normalized = normalizePricingPayload(payload);
  const entries = Object.entries(normalized);
  if (!entries.length) {
    return getSubscriptionPricingPersistent(prisma);
  }

  await Promise.all(
    entries.map(([role, values]) =>
      db.subscriptionPricing.upsert({
        where: { role },
        update: {
          monthly: values.monthly,
          yearly: values.yearly,
        },
        create: {
          role,
          monthly: values.monthly,
          yearly: values.yearly,
        },
      }),
    ),
  );

  return getSubscriptionPricingPersistent(prisma);
}
