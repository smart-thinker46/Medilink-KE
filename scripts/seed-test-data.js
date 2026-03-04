#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');
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

const SHARED_PASSWORD = process.env.TEST_SEED_PASSWORD || 'Medilink@123';
const SEED_TAG = 'seed-demo-v1';
const TARGET_COUNTS = {
  patients: Number(process.env.SEED_PATIENTS || 10),
  medics: Number(process.env.SEED_MEDICS || 10),
  pharmacies: Number(process.env.SEED_PHARMACIES || 10),
  hospitals: Number(process.env.SEED_HOSPITALS || 10),
};

const counties = ['Nairobi', 'Kiambu', 'Mombasa', 'Nakuru', 'Kisumu'];
const medicProfiles = [
  { titlePrefix: 'Dr', professionalType: 'Doctor', specialization: 'General Medicine' },
  { titlePrefix: 'Nurse', professionalType: 'Nurse', specialization: 'Critical Care Nursing' },
  { titlePrefix: 'Dr', professionalType: 'Dentist', specialization: 'Dentistry' },
  { titlePrefix: 'Officer', professionalType: 'Clinical Officer', specialization: 'Clinical Practice' },
  { titlePrefix: 'Tech', professionalType: 'Lab Technologist', specialization: 'Laboratory Medicine' },
  { titlePrefix: 'Physio', professionalType: 'Physiotherapist', specialization: 'Physiotherapy' },
  { titlePrefix: 'Counselor', professionalType: 'Psychologist', specialization: 'Mental Health' },
  { titlePrefix: 'Nutritionist', professionalType: 'Nutritionist', specialization: 'Clinical Nutrition' },
  { titlePrefix: 'Pharmacist', professionalType: 'Pharmacist', specialization: 'Pharmacotherapy' },
  { titlePrefix: 'Imaging', professionalType: 'Radiographer', specialization: 'Diagnostic Imaging' },
];

const PHARMACY_CATALOG = [
  { name: 'Paracetamol 500mg', category: 'Pain Relief', price: 120, prescriptionRequired: false, stock: 75 },
  { name: 'Amoxicillin 500mg', category: 'Antibiotics', price: 360, prescriptionRequired: true, stock: 48 },
  { name: 'Cetirizine 10mg', category: 'Allergy', price: 150, prescriptionRequired: false, stock: 52 },
  { name: 'Metformin 500mg', category: 'Diabetes', price: 320, prescriptionRequired: true, stock: 45 },
  { name: 'Omeprazole 20mg', category: 'Gastro', price: 280, prescriptionRequired: false, stock: 40 },
  { name: 'Losartan 50mg', category: 'Hypertension', price: 400, prescriptionRequired: true, stock: 38 },
  { name: 'Insulin Pen 3ml', category: 'Diabetes', price: 1350, prescriptionRequired: true, stock: 28 },
  { name: 'Salbutamol Inhaler', category: 'Respiratory', price: 540, prescriptionRequired: true, stock: 33 },
  { name: 'Vitamin C 1000mg', category: 'Supplements', price: 220, prescriptionRequired: false, stock: 60 },
  { name: 'Ibuprofen 400mg', category: 'Pain Relief', price: 180, prescriptionRequired: false, stock: 55 },
  { name: 'ORS Sachets', category: 'Rehydration', price: 70, prescriptionRequired: false, stock: 65 },
  { name: 'Azithromycin 250mg', category: 'Antibiotics', price: 680, prescriptionRequired: true, stock: 30 },
];

const HOSPITAL_INVENTORY_CATALOG = [
  { name: 'Paracetamol 1g IV', category: 'Medication', price: 260, prescriptionRequired: true, stock: 40 },
  { name: 'Ceftriaxone 1g', category: 'Medication', price: 420, prescriptionRequired: true, stock: 36 },
  { name: 'Normal Saline 500ml', category: 'Fluids', price: 180, prescriptionRequired: false, stock: 80 },
  { name: 'Dextrose 5% 500ml', category: 'Fluids', price: 210, prescriptionRequired: false, stock: 74 },
  { name: 'Sterile Syringe 10ml', category: 'Consumables', price: 35, prescriptionRequired: false, stock: 260 },
  { name: 'Examination Gloves (Box)', category: 'Consumables', price: 690, prescriptionRequired: false, stock: 58 },
  { name: 'Surgical Mask (Box)', category: 'PPE', price: 540, prescriptionRequired: false, stock: 66 },
  { name: 'Rapid Malaria Test Kit', category: 'Diagnostics', price: 140, prescriptionRequired: false, stock: 90 },
  { name: 'Pregnancy Test Kit', category: 'Diagnostics', price: 110, prescriptionRequired: false, stock: 70 },
  { name: 'Wound Dressing Pack', category: 'Consumables', price: 280, prescriptionRequired: false, stock: 48 },
  { name: 'Hydrocortisone Cream', category: 'Dermatology', price: 260, prescriptionRequired: false, stock: 44 },
  { name: 'Nebulizer Set', category: 'Equipment', price: 1950, prescriptionRequired: false, stock: 18 },
];

function isoDate(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function fakeUrl(kind, id) {
  if (kind === 'product') {
    return `https://picsum.photos/seed/medilink-${encodeURIComponent(String(id))}/640/480`;
  }
  return `https://example.com/${kind}/${id}.jpg`;
}

async function upsertUser({ email, role, phone, fullName, gender, dateOfBirth }) {
  const passwordChangedAt = new Date();
  const password = await bcrypt.hash(SHARED_PASSWORD, 10);
  const user = await prisma.user.upsert({
    where: { email: email.toLowerCase() },
    update: {
      role,
      fullName,
      phone,
      gender,
      dateOfBirth,
      password,
      passwordChangedAt,
      isEmailVerified: true,
      status: 'active',
    },
    create: {
      email: email.toLowerCase(),
      role,
      fullName,
      phone,
      gender,
      dateOfBirth,
      password,
      passwordChangedAt,
      isEmailVerified: true,
      status: 'active',
    },
  });

  return user;
}

async function upsertProfile(userId, data) {
  const existing = await prisma.userProfile.findUnique({ where: { userId } });
  const next = { ...(existing?.data || {}), ...data };
  await prisma.userProfile.upsert({
    where: { userId },
    update: { data: next },
    create: { userId, data: next },
  });
}

async function upsertMedicProfile(user, index) {
  const profile = medicProfiles[index % medicProfiles.length];
  const licenseNumber = `MED-LIC-${10000 + index}`;
  const specialization = profile.specialization;
  await prisma.medic.upsert({
    where: { userId: user.id },
    update: {
      licenseNumber,
      specialization,
      experienceYears: 4 + index,
      consultationFee: 1800 + index * 300,
      bio: `Experienced medic profile (${SEED_TAG}).`,
    },
    create: {
      userId: user.id,
      licenseNumber,
      specialization,
      experienceYears: 4 + index,
      consultationFee: 1800 + index * 300,
      bio: `Experienced medic profile (${SEED_TAG}).`,
    },
  });

  await upsertProfile(user.id, {
    createdAt: new Date().toISOString(),
    firstName: user.fullName?.split(' ')[0] || 'Medic',
    lastName: user.fullName?.split(' ').slice(1).join(' ') || 'User',
    phone: user.phone,
    email: user.email,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender || 'Male',
    professionalType: profile.professionalType,
    specialization,
    licenseNumber,
    institution: 'University of Nairobi',
    qualifications: 'BSc Nursing',
    yearCompleted: String(2015 + index),
    certifications: 'BLS, ACLS',
    experienceYears: 4 + index,
    consultationFee: 1800 + index * 300,
    license: fakeUrl('license', `medic-${index}`),
    idFront: fakeUrl('id-front', `medic-${index}`),
    idBack: fakeUrl('id-back', `medic-${index}`),
    cv: fakeUrl('cv', `medic-${index}`),
    availableCounties: [counties[index % counties.length], counties[(index + 1) % counties.length]],
    preferredShiftTypes: ['Day', 'Night'],
    hourlyRate: 1200 + index * 200,
    modeOfTransport: 'Public Vehicle',
    bankName: 'KCB',
    bankAccountNumber: `0100${index}7788`,
    bankAccountName: user.fullName,
    profilePhoto: fakeUrl('avatar', `medic-${index}`),
    locationAddress: `${counties[index % counties.length]} CBD`,
    verificationStatus: 'VERIFIED',
    verifiedAt: new Date().toISOString(),
    [SEED_TAG]: true,
  });
}

function generatePeople(role, count, baseEmailPrefix, basePhonePrefix) {
  const firstNames = [
    'Amina', 'Brian', 'Clara', 'Dennis', 'Eunice', 'Felix', 'Grace', 'Hassan', 'Irene', 'Joel',
    'Kevin', 'Lilian', 'Martin', 'Nancy', 'Oscar', 'Purity', 'Quincy', 'Ruth', 'Samuel', 'Tracy',
    'Umar', 'Violet', 'Wycliffe', 'Xavier', 'Yvonne', 'Zainab',
  ];
  const lastNames = [
    'Njeri', 'Otieno', 'Wanjiru', 'Kiptoo', 'Kamau', 'Achieng', 'Maina', 'Chebet', 'Mwangi', 'Mutiso',
    'Kariuki', 'Naliaka', 'Wekesa', 'Abdi', 'Koech', 'Nyambura', 'Wambui', 'Kimani', 'Odhiambo', 'Muthoni',
  ];

  const list = [];
  for (let i = 0; i < count; i += 1) {
    const first = firstNames[i % firstNames.length];
    const last = lastNames[(i * 3) % lastNames.length];
    const fullName = `${first} ${last}`;
    const email = `${baseEmailPrefix}${i + 1}@test.medilink.local`;
    const phone = `${basePhonePrefix}${String(i + 1).padStart(3, '0')}`;
    const gender = i % 2 === 0 ? 'Female' : 'Male';
    const year = role === 'PATIENT' ? 1985 + (i % 15) : 1978 + (i % 12);
    const month = (i % 12) + 1;
    const day = (i % 27) + 1;
    list.push({
      email,
      phone,
      fullName,
      gender,
      dob: isoDate(year, month, day),
    });
  }
  return list;
}

async function upsertPatientProfile(user, index) {
  await upsertProfile(user.id, {
    createdAt: new Date().toISOString(),
    firstName: user.fullName?.split(' ')[0] || 'Patient',
    lastName: user.fullName?.split(' ').slice(1).join(' ') || 'User',
    phone: user.phone,
    email: user.email,
    dateOfBirth: user.dateOfBirth,
    gender: user.gender || 'Female',
    homeCountry: 'Kenya',
    subCounty: `SubCounty ${index + 1}`,
    ward: `Ward ${index + 1}`,
    address: `${counties[index % counties.length]} Estate ${index + 7}`,
    emergencyContactName: `Emergency Contact ${index + 1}`,
    emergencyContactPhone: `+2547110005${index}`,
    emergencyContactRelationship: 'Sibling',
    preferredLanguage: index % 2 === 0 ? 'English' : 'Swahili',
    bloodGroup: ['A+', 'O+', 'B+'][index % 3],
    allergies: ['Pollen'],
    chronicCondition: index % 2 === 0 ? 'Hypertension' : 'None',
    idFront: fakeUrl('id-front', `patient-${index}`),
    idBack: fakeUrl('id-back', `patient-${index}`),
    profilePhoto: fakeUrl('avatar', `patient-${index}`),
    locationAddress: `${counties[index % counties.length]} Residence`,
    [SEED_TAG]: true,
  });
}

async function upsertHospitalAdmin(user, index) {
  const hospitalName = `Test Hospital ${index + 1}`;
  const registrationNumber = `HSP-${7000 + index}`;

  const existing = await prisma.tenant.findFirst({
    where: { type: 'HOSPITAL', email: user.email },
  });

  const tenant = existing
    ? await prisma.tenant.update({
        where: { id: existing.id },
        data: {
          name: hospitalName,
          status: 'ACTIVE',
          registrationNumber,
          email: user.email,
          phone: user.phone,
          subscriptionStatus: 'active',
          location: {
            address: `${counties[index % counties.length]} General Area`,
            county: counties[index % counties.length],
          },
          verifiedAt: new Date(),
        },
      })
    : await prisma.tenant.create({
        data: {
          name: hospitalName,
          type: 'HOSPITAL',
          status: 'ACTIVE',
          registrationNumber,
          email: user.email,
          phone: user.phone,
          subscriptionStatus: 'active',
          location: {
            address: `${counties[index % counties.length]} General Area`,
            county: counties[index % counties.length],
          },
          verifiedAt: new Date(),
        },
      });

  await prisma.tenantUser.upsert({
    where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
    update: { role: 'HOSPITAL_ADMIN', isPrimary: true },
    create: { userId: user.id, tenantId: tenant.id, role: 'HOSPITAL_ADMIN', isPrimary: true },
  });

  await upsertProfile(user.id, {
    createdAt: new Date().toISOString(),
    hospitalName,
    facilityType: 'Level 4',
    registrationNumber,
    adminName: user.fullName,
    adminContact: user.phone,
    adminEmail: user.email,
    phone: user.phone,
    address: `${counties[index % counties.length]} Road 20`,
    county: counties[index % counties.length],
    subCounty: `SubCounty ${index + 3}`,
    nearestTown: `${counties[index % counties.length]} Town`,
    managerName: `Manager ${index + 1}`,
    managerPhone: `+2547220044${index}`,
    bedCapacity: 80 + index * 10,
    specialties: ['Cardiology', 'Maternity', 'Radiology'],
    operatingHours: '24 Hours',
    workingDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    services: ['Emergency', 'Surgery', 'Outpatient'],
    paymentModes: ['Cash', 'Mpesa', 'Insurance'],
    patientVolume: 140 + index * 15,
    license: fakeUrl('hospital-license', index),
    adminId: fakeUrl('admin-id', `hospital-${index}`),
    profilePhoto: fakeUrl('hospital-photo', index),
    locationAddress: `${counties[index % counties.length]} ${hospitalName}`,
    verificationStatus: 'VERIFIED',
    verifiedAt: new Date().toISOString(),
    [SEED_TAG]: true,
  });

  await ensureHospitalCatalog(tenant, user.id, index);

  return tenant;
}

async function upsertPharmacyAdmin(user, index) {
  const pharmacyName = `Test Pharmacy ${index + 1}`;
  const registrationNumber = `PHA-${5000 + index}`;

  const existing = await prisma.tenant.findFirst({
    where: { type: 'PHARMACY', email: user.email },
  });

  const tenant = existing
    ? await prisma.tenant.update({
        where: { id: existing.id },
        data: {
          name: pharmacyName,
          status: 'ACTIVE',
          registrationNumber,
          email: user.email,
          phone: user.phone,
          subscriptionStatus: 'active',
          location: {
            address: `${counties[index % counties.length]} CBD`,
            county: counties[index % counties.length],
          },
          verifiedAt: new Date(),
        },
      })
    : await prisma.tenant.create({
        data: {
          name: pharmacyName,
          type: 'PHARMACY',
          status: 'ACTIVE',
          registrationNumber,
          email: user.email,
          phone: user.phone,
          subscriptionStatus: 'active',
          location: {
            address: `${counties[index % counties.length]} CBD`,
            county: counties[index % counties.length],
          },
          verifiedAt: new Date(),
        },
      });

  await prisma.tenantUser.upsert({
    where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
    update: { role: 'PHARMACY_ADMIN', isPrimary: true },
    create: { userId: user.id, tenantId: tenant.id, role: 'PHARMACY_ADMIN', isPrimary: true },
  });

  await upsertProfile(user.id, {
    createdAt: new Date().toISOString(),
    pharmacyName,
    pharmacyType: 'Retail',
    registrationNumber,
    adminName: user.fullName,
    ownerName: user.fullName,
    ownerPhone: user.phone,
    ownerEmail: user.email,
    phone: user.phone,
    address: `${counties[index % counties.length]} Street 10`,
    county: counties[index % counties.length],
    townCity: `${counties[index % counties.length]} City`,
    operatingHours: '08:00 - 22:00',
    offDays: ['Sunday'],
    deliveryAvailable: true,
    deliveryFee: 200,
    pharmacistInChargeName: `Pharmacist ${index + 1}`,
    pharmacistInChargePhone: `+2547332002${index}`,
    pharmacistInChargeEmail: `pharmacist${index + 1}@test.medilink.local`,
    paymentMethod: ['Mpesa', 'Cash', 'Card'],
    license: fakeUrl('pharmacy-license', index),
    ownerIdFront: fakeUrl('owner-id-front', index),
    ownerIdBack: fakeUrl('owner-id-back', index),
    adminId: fakeUrl('admin-id', `pharmacy-${index}`),
    profilePhoto: fakeUrl('pharmacy-photo', index),
    locationAddress: `${counties[index % counties.length]} ${pharmacyName}`,
    verificationStatus: 'VERIFIED',
    verifiedAt: new Date().toISOString(),
    [SEED_TAG]: true,
  });

  await ensurePharmacyCatalog(tenant, user.id, index);

  return tenant;
}

async function ensureTenantCatalog({
  tenant,
  actorUserId,
  indexSeed = 0,
  catalog,
  skuPrefix,
  manufacturer,
}) {
  for (let i = 0; i < catalog.length; i += 1) {
    const entry = catalog[i];
    const sku = `${skuPrefix}-${tenant.id.slice(0, 6)}-${i + 1}`;
    const existingProduct = await prisma.product.findFirst({
      where: { pharmacyId: tenant.id, sku },
    });

    const stock = Number(entry.stock || 20 + i * 7 + indexSeed);
    const data = {
      pharmacyId: tenant.id,
      name: entry.name,
      productName: entry.name,
      description: `Seeded product (${SEED_TAG})`,
      category: entry.category,
      prescriptionRequired: Boolean(entry.prescriptionRequired),
      requiresPrescription: Boolean(entry.prescriptionRequired),
      quantity: stock,
      stock,
      numberInStock: stock,
      price: entry.price,
      expiryDate: isoDate(2027, (i % 12) + 1, 20),
      manufacturer: manufacturer || 'Test Pharma Ltd',
      batchNumber: `BATCH-${skuPrefix}-${tenant.id.slice(0, 6)}-${i + 1}`,
      sku: sku.toUpperCase(),
      barcode: `BAR-${skuPrefix}-${tenant.id.slice(0, 6)}-${i + 1}`,
      reorderLevel: 6,
      imageUrl: fakeUrl('product', `${skuPrefix}-${tenant.id.slice(0, 6)}-${i + 1}`),
    };

    let product;
    if (existingProduct) {
      product = await prisma.product.update({ where: { id: existingProduct.id }, data });
    } else {
      product = await prisma.product.create({ data });
      await prisma.stockMovement.create({
        data: {
          pharmacyId: tenant.id,
          productId: product.id,
          productName: product.name,
          type: 'CREATED',
          quantityChange: stock,
          stockBefore: 0,
          stockAfter: stock,
          reason: `Initial seed (${SEED_TAG})`,
          actorId: actorUserId || null,
        },
      });
    }
  }
}

async function ensurePharmacyCatalog(tenant, actorUserId, indexSeed = 0) {
  await ensureTenantCatalog({
    tenant,
    actorUserId,
    indexSeed,
    catalog: PHARMACY_CATALOG,
    skuPrefix: 'PHA',
    manufacturer: 'MediLink Pharma Supply',
  });
}

async function ensureHospitalCatalog(tenant, actorUserId, indexSeed = 0) {
  await ensureTenantCatalog({
    tenant,
    actorUserId,
    indexSeed,
    catalog: HOSPITAL_INVENTORY_CATALOG,
    skuPrefix: 'HSP',
    manufacturer: 'MediLink Hospital Supply',
  });
}

async function backfillAllPharmacyCatalog() {
  const pharmacies = await prisma.tenant.findMany({
    where: { type: 'PHARMACY' },
    include: { users: true },
  });

  for (let i = 0; i < pharmacies.length; i += 1) {
    const pharmacy = pharmacies[i];
    const primary = pharmacy.users.find((u) => u.isPrimary) || pharmacy.users[0];
    await ensurePharmacyCatalog(pharmacy, primary?.userId || null, i);
  }
}

async function backfillAllHospitalCatalog() {
  const hospitals = await prisma.tenant.findMany({
    where: { type: 'HOSPITAL' },
    include: { users: true },
  });

  for (let i = 0; i < hospitals.length; i += 1) {
    const hospital = hospitals[i];
    const primary = hospital.users.find((u) => u.isPrimary) || hospital.users[0];
    await ensureHospitalCatalog(hospital, primary?.userId || null, i);
  }
}

async function seedRelations({ patients, medics, pharmacyAdmins }) {
  if (!patients.length || !medics.length || !pharmacyAdmins.length) return;

  for (let i = 0; i < patients.length; i += 1) {
    const patient = patients[i];
    const medic = medics[i % medics.length];
    const pharmacy = pharmacyAdmins[i % pharmacyAdmins.length];

    const note = `Follow-up check ${i + 1} (${SEED_TAG})`;
    const existingRecord = await prisma.medicalRecord.findFirst({
      where: {
        patientId: patient.id,
        medicId: medic.id,
        notes: { contains: SEED_TAG },
      },
    });

    if (!existingRecord) {
      await prisma.medicalRecord.create({
        data: {
          patientId: patient.id,
          medicId: medic.id,
          type: 'consultation',
          notes: note,
          condition: i % 2 === 0 ? 'Hypertension monitoring' : 'Routine checkup',
          attachments: {
            attendedBy: medic.fullName,
            pharmacy: pharmacy.fullName,
            tag: SEED_TAG,
          },
        },
      });
    }

    const existingMessage = await prisma.message.findFirst({
      where: {
        senderId: medic.id,
        recipientId: patient.id,
        text: { contains: SEED_TAG },
      },
    });

    if (!existingMessage) {
      await prisma.message.create({
        data: {
          senderId: medic.id,
          recipientId: patient.id,
          text: `Hello ${patient.fullName}, your next review is in 2 weeks. (${SEED_TAG})`,
          channel: 'chat',
          deliveredAt: new Date(),
          readAt: null,
        },
      });
    }
  }
}

async function main() {
  const userMatrix = {
    patients: generatePeople('PATIENT', TARGET_COUNTS.patients, 'patient', '+254701100'),
    medics: generatePeople('MEDIC', TARGET_COUNTS.medics, 'medic', '+254702200').map((p, i) => ({
      ...p,
      fullName: `${medicProfiles[i % medicProfiles.length].titlePrefix} ${p.fullName}`,
    })),
    pharmacies: generatePeople('PHARMACY_ADMIN', TARGET_COUNTS.pharmacies, 'pharmacy', '+254703300').map((p) => ({
      ...p,
      fullName: `${p.fullName} PharmacyAdmin`,
    })),
    hospitals: generatePeople('HOSPITAL_ADMIN', TARGET_COUNTS.hospitals, 'hospital', '+254704400').map((p) => ({
      ...p,
      fullName: `${p.fullName} HospitalAdmin`,
    })),
  };

  const created = {
    patients: [],
    medics: [],
    pharmacies: [],
    hospitals: [],
  };

  for (let i = 0; i < userMatrix.patients.length; i += 1) {
    const u = userMatrix.patients[i];
    const user = await upsertUser({
      email: u.email,
      role: 'PATIENT',
      phone: u.phone,
      fullName: u.fullName,
      gender: u.gender,
      dateOfBirth: u.dob,
    });
    await upsertPatientProfile(user, i);
    created.patients.push(user);
  }

  for (let i = 0; i < userMatrix.medics.length; i += 1) {
    const u = userMatrix.medics[i];
    const user = await upsertUser({
      email: u.email,
      role: 'MEDIC',
      phone: u.phone,
      fullName: u.fullName,
      gender: u.gender,
      dateOfBirth: u.dob,
    });
    await upsertMedicProfile(user, i);
    created.medics.push(user);
  }

  for (let i = 0; i < userMatrix.pharmacies.length; i += 1) {
    const u = userMatrix.pharmacies[i];
    const user = await upsertUser({
      email: u.email,
      role: 'PHARMACY_ADMIN',
      phone: u.phone,
      fullName: u.fullName,
      gender: u.gender,
      dateOfBirth: u.dob,
    });
    await upsertPharmacyAdmin(user, i);
    created.pharmacies.push(user);
  }

  for (let i = 0; i < userMatrix.hospitals.length; i += 1) {
    const u = userMatrix.hospitals[i];
    const user = await upsertUser({
      email: u.email,
      role: 'HOSPITAL_ADMIN',
      phone: u.phone,
      fullName: u.fullName,
      gender: u.gender,
      dateOfBirth: u.dob,
    });
    await upsertHospitalAdmin(user, i);
    created.hospitals.push(user);
  }

  await seedRelations({
    patients: created.patients,
    medics: created.medics,
    pharmacyAdmins: created.pharmacies,
  });

  await backfillAllPharmacyCatalog();
  await backfillAllHospitalCatalog();

  console.log('\nSeed complete. Use the credentials below:');
  console.log(`Shared password: ${SHARED_PASSWORD}`);

  Object.entries(created).forEach(([role, users]) => {
    console.log(`\n${role.toUpperCase()}:`);
    users.forEach((user) => {
      console.log(`- ${user.email}`);
    });
  });
}

main()
  .catch((error) => {
    console.error('Failed to seed test data:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
