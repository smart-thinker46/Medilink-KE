import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';

const CONTACT_MATRIX: Record<UserRole, UserRole[]> = {
  SUPER_ADMIN: ['SUPER_ADMIN', 'HOSPITAL_ADMIN', 'PHARMACY_ADMIN', 'MEDIC', 'PATIENT'],
  PATIENT: ['SUPER_ADMIN', 'HOSPITAL_ADMIN', 'PHARMACY_ADMIN', 'MEDIC'],
  MEDIC: ['SUPER_ADMIN', 'HOSPITAL_ADMIN', 'PHARMACY_ADMIN', 'PATIENT'],
  HOSPITAL_ADMIN: ['SUPER_ADMIN', 'PHARMACY_ADMIN', 'MEDIC', 'PATIENT'],
  PHARMACY_ADMIN: ['SUPER_ADMIN', 'HOSPITAL_ADMIN', 'MEDIC', 'PATIENT'],
};

export const canCommunicate = (senderRole: UserRole, recipientRole: UserRole) => {
  const allowed = CONTACT_MATRIX[senderRole] || [];
  return allowed.includes(recipientRole);
};

export const assertCanCommunicate = (
  senderRole: UserRole,
  recipientRole: UserRole,
  label: string,
) => {
  if (!canCommunicate(senderRole, recipientRole)) {
    throw new ForbiddenException(`${label} not allowed for ${senderRole} -> ${recipientRole}`);
  }
};
