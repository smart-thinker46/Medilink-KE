const DAY_MS = 24 * 60 * 60 * 1000;

export const ALLOWED_PASSWORD_INTERVAL_DAYS = [7, 14, 30, 60, 90, 180, 365] as const;

export function normalizePasswordIntervalDays(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || Number(value) === 0) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    return null;
  }
  return (ALLOWED_PASSWORD_INTERVAL_DAYS as readonly number[]).includes(parsed) ? parsed : null;
}

export function computePasswordExpiryDate(intervalDays: number | null, from: Date = new Date()): Date | null {
  if (!intervalDays || intervalDays <= 0) return null;
  return new Date(from.getTime() + intervalDays * DAY_MS);
}

export function isPasswordExpired(expiresAt: Date | string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return false;
  return expiry.getTime() <= now.getTime();
}

export function getPasswordDaysRemaining(
  expiresAt: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (!expiresAt) return null;
  const expiry = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return null;
  const diff = expiry.getTime() - now.getTime();
  return Math.max(0, Math.ceil(diff / DAY_MS));
}
