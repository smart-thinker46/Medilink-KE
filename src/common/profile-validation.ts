import { BadRequestException } from '@nestjs/common';
import { getProfileExtras } from 'src/common/profile-extras';

const hospitalRequiredFields = (profile: Record<string, any>) => [
  { key: 'createdAt', label: 'Created at', ok: Boolean(profile?.createdAt) },
  { key: 'hospitalName', label: 'Hospital name', ok: Boolean(profile?.hospitalName?.trim()) },
  { key: 'facilityType', label: 'Facility type', ok: Boolean(profile?.facilityType?.trim()) },
  { key: 'registrationNumber', label: 'Registration number', ok: Boolean(profile?.registrationNumber?.trim()) },
  { key: 'adminName', label: 'Admin name', ok: Boolean(profile?.adminName?.trim()) },
  { key: 'adminContact', label: 'Admin contact', ok: Boolean(profile?.adminContact?.trim() || profile?.phone?.trim()) },
  { key: 'adminEmail', label: 'Admin email', ok: Boolean(profile?.adminEmail?.trim() || profile?.email?.trim()) },
  { key: 'phone', label: 'Phone', ok: Boolean(profile?.phone?.trim()) },
  { key: 'address', label: 'Address', ok: Boolean(profile?.address?.trim()) },
  { key: 'county', label: 'County', ok: Boolean(profile?.county?.trim()) },
  { key: 'subCounty', label: 'Sub county', ok: Boolean(profile?.subCounty?.trim()) },
  { key: 'nearestTown', label: 'Nearest town', ok: Boolean(profile?.nearestTown?.trim()) },
  { key: 'managerName', label: 'Manager name', ok: Boolean(profile?.managerName?.trim()) },
  { key: 'managerPhone', label: 'Manager phone', ok: Boolean(profile?.managerPhone?.trim()) },
  { key: 'bedCapacity', label: 'Bed capacity', ok: Boolean(`${profile?.bedCapacity ?? ''}`.trim()) },
  {
    key: 'specialties',
    label: 'Specialties',
    ok: Array.isArray(profile?.specialties) ? profile.specialties.length > 0 : Boolean(profile?.specialties),
  },
  { key: 'operatingHours', label: 'Operating hours', ok: Boolean(profile?.operatingHours?.trim()) },
  {
    key: 'workingDays',
    label: 'Working days',
    ok: Array.isArray(profile?.workingDays) ? profile.workingDays.length > 0 : Boolean(profile?.workingDays),
  },
  {
    key: 'services',
    label: 'Services',
    ok: Array.isArray(profile?.services) ? profile.services.length > 0 : Boolean(profile?.services),
  },
  {
    key: 'paymentModes',
    label: 'Payment modes',
    ok: Array.isArray(profile?.paymentModes)
      ? profile.paymentModes.length > 0
      : Boolean(profile?.paymentModes),
  },
  {
    key: 'patientVolume',
    label: 'Patient volume',
    ok:
      profile?.patientVolume !== null &&
      profile?.patientVolume !== undefined &&
      `${profile.patientVolume}`.trim() !== '',
  },
  {
    key: 'license',
    label: 'Hospital license',
    ok: Boolean(profile?.licenseUrl || profile?.license),
  },
  {
    key: 'adminId',
    label: 'Admin ID',
    ok: Boolean(profile?.adminIdUrl || profile?.adminId),
  },
  {
    key: 'profilePhoto',
    label: 'Hospital photo',
    ok: Boolean(profile?.profilePhoto || profile?.photoUrl),
  },
  {
    key: 'location',
    label: 'Location',
    ok: Boolean(profile?.location?.address || profile?.locationAddress),
  },
];

const pharmacyRequiredFields = (profile: Record<string, any>) => [
  { key: 'createdAt', label: 'Created at', ok: Boolean(profile?.createdAt) },
  { key: 'pharmacyName', label: 'Pharmacy name', ok: Boolean(profile?.pharmacyName?.trim()) },
  { key: 'pharmacyType', label: 'Pharmacy type', ok: Boolean(profile?.pharmacyType?.trim()) },
  { key: 'registrationNumber', label: 'Registration number', ok: Boolean(profile?.registrationNumber?.trim()) },
  { key: 'adminName', label: 'Admin name', ok: Boolean(profile?.adminName?.trim()) },
  { key: 'ownerName', label: 'Owner name', ok: Boolean(profile?.ownerName?.trim()) },
  { key: 'ownerPhone', label: 'Owner phone', ok: Boolean(profile?.ownerPhone?.trim()) },
  { key: 'ownerEmail', label: 'Owner email', ok: Boolean(profile?.ownerEmail?.trim()) },
  { key: 'phone', label: 'Phone', ok: Boolean(profile?.phone?.trim()) },
  { key: 'address', label: 'Address', ok: Boolean(profile?.address?.trim()) },
  { key: 'county', label: 'County', ok: Boolean(profile?.county?.trim()) },
  { key: 'townCity', label: 'Town/City', ok: Boolean(profile?.townCity?.trim()) },
  { key: 'operatingHours', label: 'Operating hours', ok: Boolean(profile?.operatingHours?.trim()) },
  {
    key: 'offDays',
    label: 'Off days',
    ok: Array.isArray(profile?.offDays) ? profile.offDays.length > 0 : Boolean(profile?.offDays),
  },
  {
    key: 'deliveryAvailable',
    label: 'Delivery available',
    ok: typeof profile?.deliveryAvailable === 'boolean',
  },
  {
    key: 'deliveryFee',
    label: 'Delivery fee',
    ok:
      profile?.deliveryAvailable === false ||
      (profile?.deliveryAvailable === true && `${profile?.deliveryFee ?? ''}`.trim() !== ''),
  },
  {
    key: 'pharmacistInChargeName',
    label: 'Pharmacist in charge name',
    ok: Boolean(profile?.pharmacistInChargeName?.trim()),
  },
  {
    key: 'pharmacistInChargePhone',
    label: 'Pharmacist in charge phone',
    ok: Boolean(profile?.pharmacistInChargePhone?.trim()),
  },
  {
    key: 'pharmacistInChargeEmail',
    label: 'Pharmacist in charge email',
    ok: Boolean(profile?.pharmacistInChargeEmail?.trim()),
  },
  {
    key: 'paymentMethod',
    label: 'Payment method',
    ok: Array.isArray(profile?.paymentMethod)
      ? profile.paymentMethod.length > 0
      : Boolean(profile?.paymentMethod),
  },
  {
    key: 'license',
    label: 'Pharmacy license',
    ok: Boolean(profile?.licenseUrl || profile?.license),
  },
  {
    key: 'ownerIdFront',
    label: 'Owner ID front',
    ok: Boolean(profile?.ownerIdFront || profile?.ownerIdFrontUrl),
  },
  {
    key: 'ownerIdBack',
    label: 'Owner ID back',
    ok: Boolean(profile?.ownerIdBack || profile?.ownerIdBackUrl),
  },
  {
    key: 'adminId',
    label: 'Admin ID',
    ok: Boolean(profile?.adminIdUrl || profile?.adminId),
  },
  {
    key: 'profilePhoto',
    label: 'Pharmacy photo',
    ok: Boolean(profile?.profilePhoto || profile?.photoUrl),
  },
  {
    key: 'location',
    label: 'Location',
    ok: Boolean(profile?.location?.address || profile?.locationAddress),
  },
];

const patientRequiredFields = (profile: Record<string, any>) => [
  { key: 'createdAt', label: 'Created at', ok: Boolean(profile?.createdAt) },
  { key: 'firstName', label: 'First name', ok: Boolean(profile?.firstName?.trim()) },
  { key: 'lastName', label: 'Last name', ok: Boolean(profile?.lastName?.trim()) },
  { key: 'phone', label: 'Phone', ok: Boolean(profile?.phone?.trim()) },
  { key: 'dateOfBirth', label: 'Date of birth', ok: Boolean(profile?.dateOfBirth) },
  { key: 'gender', label: 'Gender', ok: Boolean(profile?.gender?.trim()) },
  { key: 'homeCountry', label: 'Home country', ok: Boolean(profile?.homeCountry?.trim()) },
  { key: 'subCounty', label: 'Sub county', ok: Boolean(profile?.subCounty?.trim()) },
  { key: 'ward', label: 'Ward', ok: Boolean(profile?.ward?.trim()) },
  { key: 'address', label: 'Address', ok: Boolean(profile?.address?.trim()) },
  {
    key: 'emergencyContactName',
    label: 'Emergency contact name',
    ok: Boolean(profile?.emergencyContactName?.trim()),
  },
  {
    key: 'emergencyContactPhone',
    label: 'Emergency contact phone',
    ok: Boolean(profile?.emergencyContactPhone?.trim()),
  },
  {
    key: 'emergencyContactRelationship',
    label: 'Emergency contact relationship',
    ok: Boolean(profile?.emergencyContactRelationship?.trim()),
  },
  {
    key: 'preferredLanguage',
    label: 'Preferred language',
    ok: Boolean(profile?.preferredLanguage?.trim()),
  },
  {
    key: 'location',
    label: 'Location',
    ok: Boolean(profile?.location?.address || profile?.locationAddress),
  },
  {
    key: 'profilePhoto',
    label: 'Profile photo',
    ok: Boolean(profile?.profilePhoto || profile?.avatarUrl || profile?.photoUrl),
  },
  {
    key: 'idFront',
    label: 'ID front',
    ok: Boolean(profile?.idFront || profile?.idFrontUrl),
  },
  {
    key: 'idBack',
    label: 'ID back',
    ok: Boolean(profile?.idBack || profile?.idBackUrl),
  },
];

const medicRequiredFields = (profile: Record<string, any>) => [
  { key: 'createdAt', label: 'Created at', ok: Boolean(profile?.createdAt) },
  { key: 'firstName', label: 'First name', ok: Boolean(profile?.firstName?.trim()) },
  { key: 'lastName', label: 'Last name', ok: Boolean(profile?.lastName?.trim()) },
  { key: 'phone', label: 'Phone', ok: Boolean(profile?.phone?.trim()) },
  { key: 'dateOfBirth', label: 'Date of birth', ok: Boolean(profile?.dateOfBirth) },
  { key: 'gender', label: 'Gender', ok: Boolean(profile?.gender?.trim()) },
  { key: 'professionalType', label: 'Professional type', ok: Boolean(profile?.professionalType?.trim()) },
  { key: 'specialization', label: 'Specialization', ok: Boolean(profile?.specialization?.trim()) },
  { key: 'licenseNumber', label: 'License number', ok: Boolean(profile?.licenseNumber?.trim()) },
  { key: 'institution', label: 'Institution', ok: Boolean(profile?.institution?.trim()) },
  { key: 'qualifications', label: 'Qualifications', ok: Boolean(profile?.qualifications?.trim()) },
  { key: 'yearCompleted', label: 'Year completed', ok: Boolean(`${profile?.yearCompleted ?? ''}`.trim()) },
  { key: 'certifications', label: 'Certifications', ok: Boolean(profile?.certifications?.trim()) },
  {
    key: 'experienceYears',
    label: 'Experience years',
    ok:
      profile?.experienceYears !== null &&
      profile?.experienceYears !== undefined &&
      `${profile.experienceYears}`.trim() !== '',
  },
  {
    key: 'consultationFee',
    label: 'Consultation fee',
    ok:
      profile?.consultationFee !== null &&
      profile?.consultationFee !== undefined &&
      `${profile.consultationFee}`.trim() !== '',
  },
  {
    key: 'license',
    label: 'Medical license document',
    ok: Boolean(profile?.licenseUrl || profile?.license),
  },
  {
    key: 'idFront',
    label: 'ID front',
    ok: Boolean(profile?.idFront || profile?.idFrontUrl),
  },
  {
    key: 'idBack',
    label: 'ID back',
    ok: Boolean(profile?.idBack || profile?.idBackUrl),
  },
  {
    key: 'cv',
    label: 'CV upload',
    ok: Boolean(profile?.cvUrl || profile?.cv),
  },
  {
    key: 'availableCounties',
    label: 'Available counties',
    ok: Array.isArray(profile?.availableCounties)
      ? profile.availableCounties.length > 0
      : Boolean(profile?.availableCounties),
  },
  {
    key: 'preferredShiftTypes',
    label: 'Preferred shift types',
    ok: Array.isArray(profile?.preferredShiftTypes)
      ? profile.preferredShiftTypes.length > 0
      : Boolean(profile?.preferredShiftTypes),
  },
  { key: 'hourlyRate', label: 'Hourly rate', ok: Boolean(`${profile?.hourlyRate ?? ''}`.trim()) },
  { key: 'modeOfTransport', label: 'Mode of transport', ok: Boolean(profile?.modeOfTransport?.trim()) },
  { key: 'bankName', label: 'Bank name', ok: Boolean(profile?.bankName?.trim()) },
  { key: 'bankAccountNumber', label: 'Account number', ok: Boolean(profile?.bankAccountNumber?.trim()) },
  { key: 'bankAccountName', label: 'Account name', ok: Boolean(profile?.bankAccountName?.trim()) },
  {
    key: 'profilePhoto',
    label: 'Profile photo',
    ok: Boolean(profile?.profilePhoto || profile?.avatarUrl || profile?.photoUrl),
  },
];

const throwIfMissing = (fields: { ok: boolean; label: string }[]) => {
  const missing = fields.filter((field) => !field.ok).map((field) => field.label);
  if (missing.length > 0) {
    throw new BadRequestException({
      message: 'Profile incomplete',
      missingFields: missing,
    });
  }
};

export const ensureHospitalProfileComplete = async (prisma: any, userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== 'HOSPITAL_ADMIN') return;
  const extras = await getProfileExtras(prisma, userId);
  const profile = { ...user, ...extras };
  throwIfMissing(hospitalRequiredFields(profile));
};

export const ensurePharmacyProfileComplete = async (prisma: any, userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== 'PHARMACY_ADMIN') return;
  const extras = await getProfileExtras(prisma, userId);
  const profile = { ...user, ...extras };
  throwIfMissing(pharmacyRequiredFields(profile));
};

export const ensurePatientProfileComplete = async (prisma: any, userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== 'PATIENT') return;
  const extras = await getProfileExtras(prisma, userId);
  const profile = { ...user, ...extras };
  throwIfMissing(patientRequiredFields(profile));
};

export const ensureMedicProfileComplete = async (prisma: any, userId: string) => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.role !== 'MEDIC') return;
  const extras = await getProfileExtras(prisma, userId);
  const profile = { ...user, ...extras };
  throwIfMissing(medicRequiredFields(profile));
};
