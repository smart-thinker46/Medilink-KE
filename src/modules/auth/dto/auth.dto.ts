
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const UserRoleSchema = z.enum([
  'SUPER_ADMIN',
  'HOSPITAL_ADMIN',
  'PHARMACY_ADMIN',
  'MEDIC',
  'PATIENT',
]);

export const RegisterUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  fullName: z.string().min(2).optional(), // Can come from firstName + lastName
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  role: UserRoleSchema,
  phone: z.string().optional(),
  
  // For tenant registration
  tenantName: z.string().optional(),
  tenantType: z.enum(['HOSPITAL', 'PHARMACY']).optional(),
  registrationNumber: z.string().optional(),
  
  // Profile Fields
  dateOfBirth: z.string().optional(), // Frontend sends string
  gender: z.string().optional(),
  emergencyContactName: z.string().optional(),
  emergencyContactPhone: z.string().optional(),
  
  // Medic Fields
  licenseNumber: z.string().optional(),
  specialization: z.string().optional(),
  experienceYears: z.number().optional(),
  consultationFee: z.number().optional(),
  bio: z.string().optional(),
});

export class RegisterUserDto extends createZodDto(RegisterUserSchema) {}

export const LoginUserSchema = z.object({
  email: z.string().email(),
  password: z.string(),
  // If logging into a specific tenant context immediately
  tenantId: z.string().uuid().optional(),
});

export class LoginUserDto extends createZodDto(LoginUserSchema) {}
