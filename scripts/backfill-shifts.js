#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  const envContent = fs.readFileSync(envPath, 'utf8');
  envContent.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const idx = trimmed.indexOf('=');
    if (idx < 0) return;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^"|"$/g, '');
    if (!process.env[key]) process.env[key] = value;
  });
}

const prisma = new PrismaClient();

function toDate(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  return parsed;
}

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback;
}

function toDecimalString(value, fallback = '0') {
  if (value === null || value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(parsed) : fallback;
}

async function main() {
  console.log('Backfilling shifts from audit_logs...');

  const rows = await prisma.auditLog.findMany({
    where: { resource: 'SHIFT', action: 'SHIFT_RECORD' },
    orderBy: { createdAt: 'asc' },
  });

  if (!rows.length) {
    console.log('No SHIFT_RECORD rows found in audit_logs.');
    return;
  }

  const payload = rows
    .map((row) => {
      const details = row.details && typeof row.details === 'object' ? row.details : {};
      const title = String(details.title || details.task || '').trim();
      if (!title) return null;

      const createdAt = toDate(details.createdAt, row.createdAt);
      const updatedAt = toDate(details.updatedAt, createdAt);

      return {
        id: row.id,
        title,
        description: details.description ? String(details.description) : null,
        specifications: details.specifications ? String(details.specifications) : null,
        specialization: details.specialization
          ? String(details.specialization)
          : details.category
            ? String(details.category)
            : null,
        requiredMedics: toInt(details.requiredMedics ?? details.medicsRequired, 0),
        hours: toInt(details.hours, 0),
        payType: details.payType ? String(details.payType) : null,
        payAmount: toDecimalString(details.payAmount, '0'),
        status: String(details.status || 'OPEN').toUpperCase(),
        createdBy: String(details.createdBy || row.userId || '').trim(),
        hospitalName: details.hospitalName ? String(details.hospitalName) : null,
        location: details.location ? String(details.location) : null,
        applications: Array.isArray(details.applications) ? details.applications : [],
        cancellationReason: details.cancellationReason
          ? String(details.cancellationReason)
          : null,
        cancelledAt: details.cancelledAt ? toDate(details.cancelledAt, null) : null,
        cancelledBy: details.cancelledBy ? String(details.cancelledBy) : null,
        createdAt,
        updatedAt,
      };
    })
    .filter(Boolean)
    .filter((item) => item.createdBy);

  if (!payload.length) {
    console.log('No valid shift records to backfill.');
    return;
  }

  const result = await prisma.shift.createMany({
    data: payload,
    skipDuplicates: true,
  });

  console.log(`Backfill complete. Inserted ${result.count} shift record(s).`);
}

main()
  .catch((error) => {
    console.error('Backfill failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

