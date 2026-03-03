
Object.defineProperty(exports, "__esModule", { value: true });

const {
  Decimal,
  objectEnumValues,
  makeStrictEnum,
  Public,
  getRuntime,
  skip
} = require('./runtime/index-browser.js')


const Prisma = {}

exports.Prisma = Prisma
exports.$Enums = {}

/**
 * Prisma Client JS version: 5.22.0
 * Query Engine version: 605197351a3c8bdd595af2d2a9bc3025bca48ea2
 */
Prisma.prismaVersion = {
  client: "5.22.0",
  engine: "605197351a3c8bdd595af2d2a9bc3025bca48ea2"
}

Prisma.PrismaClientKnownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientKnownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)};
Prisma.PrismaClientUnknownRequestError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientUnknownRequestError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientRustPanicError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientRustPanicError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientInitializationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientInitializationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientValidationError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`PrismaClientValidationError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.NotFoundError = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`NotFoundError is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.Decimal = Decimal

/**
 * Re-export of sql-template-tag
 */
Prisma.sql = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`sqltag is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.empty = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`empty is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.join = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`join is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.raw = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`raw is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.validator = Public.validator

/**
* Extensions
*/
Prisma.getExtensionContext = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.getExtensionContext is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.defineExtension = () => {
  const runtimeName = getRuntime().prettyName;
  throw new Error(`Extensions.defineExtension is unable to run in this browser environment, or has been bundled for the browser (running in ${runtimeName}).
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}

/**
 * Shorthand utilities for JSON filtering
 */
Prisma.DbNull = objectEnumValues.instances.DbNull
Prisma.JsonNull = objectEnumValues.instances.JsonNull
Prisma.AnyNull = objectEnumValues.instances.AnyNull

Prisma.NullTypes = {
  DbNull: objectEnumValues.classes.DbNull,
  JsonNull: objectEnumValues.classes.JsonNull,
  AnyNull: objectEnumValues.classes.AnyNull
}



/**
 * Enums
 */

exports.Prisma.TransactionIsolationLevel = makeStrictEnum({
  ReadUncommitted: 'ReadUncommitted',
  ReadCommitted: 'ReadCommitted',
  RepeatableRead: 'RepeatableRead',
  Serializable: 'Serializable'
});

exports.Prisma.PatientScalarFieldEnum = {
  id: 'id',
  fullName: 'fullName',
  dob: 'dob',
  gender: 'gender',
  nationalId: 'nationalId',
  phone: 'phone',
  email: 'email',
  profilePhotoUrl: 'profilePhotoUrl',
  address: 'address',
  emergencyContact: 'emergencyContact',
  bloodGroup: 'bloodGroup',
  allergies: 'allergies',
  chronicConditions: 'chronicConditions',
  currentMedications: 'currentMedications',
  pastHistory: 'pastHistory',
  surgeries: 'surgeries',
  insuranceProvider: 'insuranceProvider',
  insuranceMemberId: 'insuranceMemberId',
  preferredHospitalId: 'preferredHospitalId',
  primaryPhysicianId: 'primaryPhysicianId',
  consentFlags: 'consentFlags',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.InpatientScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  admissionDate: 'admissionDate',
  dischargeDate: 'dischargeDate',
  status: 'status',
  wardId: 'wardId',
  bedId: 'bedId'
};

exports.Prisma.AppointmentScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  medicId: 'medicId',
  dateTime: 'dateTime',
  status: 'status',
  type: 'type',
  notes: 'notes'
};

exports.Prisma.VisitScalarFieldEnum = {
  id: 'id',
  appointmentId: 'appointmentId',
  patientId: 'patientId',
  medicId: 'medicId',
  checkInTime: 'checkInTime',
  checkOutTime: 'checkOutTime',
  type: 'type',
  triageData: 'triageData'
};

exports.Prisma.MedicalRecordScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  medicId: 'medicId',
  visitId: 'visitId',
  date: 'date',
  chiefComplaint: 'chiefComplaint',
  diagnosis: 'diagnosis',
  notes: 'notes',
  treatmentPlan: 'treatmentPlan'
};

exports.Prisma.VitalsScalarFieldEnum = {
  id: 'id',
  visitId: 'visitId',
  recordedAt: 'recordedAt',
  temperature: 'temperature',
  bloodPressure: 'bloodPressure',
  pulse: 'pulse',
  respiratoryRate: 'respiratoryRate',
  oxygenSaturation: 'oxygenSaturation',
  weight: 'weight',
  height: 'height',
  bmi: 'bmi'
};

exports.Prisma.NursingNoteScalarFieldEnum = {
  id: 'id',
  inpatientId: 'inpatientId',
  nurseId: 'nurseId',
  note: 'note',
  recordedAt: 'recordedAt'
};

exports.Prisma.MedicationAdministrationScalarFieldEnum = {
  id: 'id',
  inpatientId: 'inpatientId',
  prescriptionId: 'prescriptionId',
  drugName: 'drugName',
  dosage: 'dosage',
  administeredBy: 'administeredBy',
  administeredAt: 'administeredAt',
  status: 'status'
};

exports.Prisma.WardScalarFieldEnum = {
  id: 'id',
  name: 'name',
  type: 'type',
  capacity: 'capacity'
};

exports.Prisma.BedScalarFieldEnum = {
  id: 'id',
  wardId: 'wardId',
  number: 'number',
  status: 'status'
};

exports.Prisma.LabRequestScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  medicId: 'medicId',
  testType: 'testType',
  priority: 'priority',
  status: 'status',
  requestedAt: 'requestedAt'
};

exports.Prisma.LabResultScalarFieldEnum = {
  id: 'id',
  labRequestId: 'labRequestId',
  technicianId: 'technicianId',
  resultData: 'resultData',
  comments: 'comments',
  verifiedBy: 'verifiedBy',
  completedAt: 'completedAt'
};

exports.Prisma.RadiologyRequestScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  medicId: 'medicId',
  scanType: 'scanType',
  bodyPart: 'bodyPart',
  status: 'status',
  requestedAt: 'requestedAt'
};

exports.Prisma.RadiologyReportScalarFieldEnum = {
  id: 'id',
  requestId: 'requestId',
  radiologistId: 'radiologistId',
  imageUrl: 'imageUrl',
  findings: 'findings',
  conclusion: 'conclusion',
  reportedAt: 'reportedAt'
};

exports.Prisma.InventoryItemScalarFieldEnum = {
  id: 'id',
  name: 'name',
  sku: 'sku',
  category: 'category',
  quantity: 'quantity',
  reorderLevel: 'reorderLevel',
  unitPrice: 'unitPrice',
  costPrice: 'costPrice',
  expiryDate: 'expiryDate',
  batchNumber: 'batchNumber',
  supplierId: 'supplierId',
  location: 'location'
};

exports.Prisma.PrescriptionScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  medicId: 'medicId',
  status: 'status',
  issuedAt: 'issuedAt'
};

exports.Prisma.PrescriptionItemScalarFieldEnum = {
  id: 'id',
  prescriptionId: 'prescriptionId',
  drugName: 'drugName',
  dosage: 'dosage',
  frequency: 'frequency',
  duration: 'duration',
  quantity: 'quantity'
};

exports.Prisma.DispenseScalarFieldEnum = {
  id: 'id',
  prescriptionId: 'prescriptionId',
  pharmacistId: 'pharmacistId',
  dispensedAt: 'dispensedAt',
  totalCost: 'totalCost'
};

exports.Prisma.DispenseItemScalarFieldEnum = {
  id: 'id',
  dispenseId: 'dispenseId',
  inventoryItemId: 'inventoryItemId',
  quantity: 'quantity',
  price: 'price'
};

exports.Prisma.BillScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  totalAmount: 'totalAmount',
  paidAmount: 'paidAmount',
  status: 'status',
  generatedAt: 'generatedAt',
  dueDate: 'dueDate'
};

exports.Prisma.BillItemScalarFieldEnum = {
  id: 'id',
  billId: 'billId',
  description: 'description',
  amount: 'amount',
  quantity: 'quantity',
  serviceType: 'serviceType'
};

exports.Prisma.PaymentScalarFieldEnum = {
  id: 'id',
  billId: 'billId',
  amount: 'amount',
  method: 'method',
  transactionId: 'transactionId',
  paymentDate: 'paymentDate',
  receivedBy: 'receivedBy'
};

exports.Prisma.StaffScalarFieldEnum = {
  id: 'id',
  userId: 'userId',
  fullName: 'fullName',
  role: 'role',
  specialization: 'specialization',
  department: 'department',
  phone: 'phone',
  email: 'email',
  status: 'status',
  shiftSchedule: 'shiftSchedule'
};

exports.Prisma.BloodStockScalarFieldEnum = {
  id: 'id',
  bloodGroup: 'bloodGroup',
  units: 'units',
  expiryDate: 'expiryDate'
};

exports.Prisma.OTBookingScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  surgeryType: 'surgeryType',
  scheduledAt: 'scheduledAt',
  durationMinutes: 'durationMinutes',
  surgeonId: 'surgeonId',
  status: 'status'
};

exports.Prisma.EmergencyCaseScalarFieldEnum = {
  id: 'id',
  triageLevel: 'triageLevel',
  location: 'location',
  arrival: 'arrival'
};

exports.Prisma.MealOrderScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  staffId: 'staffId',
  items: 'items',
  status: 'status'
};

exports.Prisma.SurveyResponseScalarFieldEnum = {
  id: 'id',
  patientId: 'patientId',
  rating: 'rating',
  comments: 'comments',
  createdAt: 'createdAt'
};

exports.Prisma.AmbulanceDispatchScalarFieldEnum = {
  id: 'id',
  vehicleNo: 'vehicleNo',
  driverId: 'driverId',
  destination: 'destination',
  status: 'status'
};

exports.Prisma.MortuaryRecordScalarFieldEnum = {
  id: 'id',
  deceasedName: 'deceasedName',
  dateOfDeath: 'dateOfDeath',
  causeOfDeath: 'causeOfDeath',
  storageUnit: 'storageUnit'
};

exports.Prisma.PurchaseOrderScalarFieldEnum = {
  id: 'id',
  supplierId: 'supplierId',
  items: 'items',
  status: 'status',
  createdAt: 'createdAt'
};

exports.Prisma.SupplierScalarFieldEnum = {
  id: 'id',
  name: 'name',
  contact: 'contact',
  email: 'email'
};

exports.Prisma.SortOrder = {
  asc: 'asc',
  desc: 'desc'
};

exports.Prisma.NullableJsonNullValueInput = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull
};

exports.Prisma.JsonNullValueInput = {
  JsonNull: Prisma.JsonNull
};

exports.Prisma.QueryMode = {
  default: 'default',
  insensitive: 'insensitive'
};

exports.Prisma.JsonNullValueFilter = {
  DbNull: Prisma.DbNull,
  JsonNull: Prisma.JsonNull,
  AnyNull: Prisma.AnyNull
};

exports.Prisma.NullsOrder = {
  first: 'first',
  last: 'last'
};
exports.Gender = exports.$Enums.Gender = {
  MALE: 'MALE',
  FEMALE: 'FEMALE',
  OTHER: 'OTHER'
};

exports.AppointmentStatus = exports.$Enums.AppointmentStatus = {
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  NO_SHOW: 'NO_SHOW'
};

exports.PaymentMethod = exports.$Enums.PaymentMethod = {
  CASH: 'CASH',
  MPESA: 'MPESA',
  INSURANCE: 'INSURANCE',
  CARD: 'CARD'
};

exports.Prisma.ModelName = {
  Patient: 'Patient',
  Inpatient: 'Inpatient',
  Appointment: 'Appointment',
  Visit: 'Visit',
  MedicalRecord: 'MedicalRecord',
  Vitals: 'Vitals',
  NursingNote: 'NursingNote',
  MedicationAdministration: 'MedicationAdministration',
  Ward: 'Ward',
  Bed: 'Bed',
  LabRequest: 'LabRequest',
  LabResult: 'LabResult',
  RadiologyRequest: 'RadiologyRequest',
  RadiologyReport: 'RadiologyReport',
  InventoryItem: 'InventoryItem',
  Prescription: 'Prescription',
  PrescriptionItem: 'PrescriptionItem',
  Dispense: 'Dispense',
  DispenseItem: 'DispenseItem',
  Bill: 'Bill',
  BillItem: 'BillItem',
  Payment: 'Payment',
  Staff: 'Staff',
  BloodStock: 'BloodStock',
  OTBooking: 'OTBooking',
  EmergencyCase: 'EmergencyCase',
  MealOrder: 'MealOrder',
  SurveyResponse: 'SurveyResponse',
  AmbulanceDispatch: 'AmbulanceDispatch',
  MortuaryRecord: 'MortuaryRecord',
  PurchaseOrder: 'PurchaseOrder',
  Supplier: 'Supplier'
};

/**
 * This is a stub Prisma Client that will error at runtime if called.
 */
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        let message
        const runtime = getRuntime()
        if (runtime.isEdge) {
          message = `PrismaClient is not configured to run in ${runtime.prettyName}. In order to run Prisma Client on edge runtime, either:
- Use Prisma Accelerate: https://pris.ly/d/accelerate
- Use Driver Adapters: https://pris.ly/d/driver-adapters
`;
        } else {
          message = 'PrismaClient is unable to run in this browser environment, or has been bundled for the browser (running in `' + runtime.prettyName + '`).'
        }
        
        message += `
If this is unexpected, please open an issue: https://pris.ly/prisma-prisma-bug-report`

        throw new Error(message)
      }
    })
  }
}

exports.PrismaClient = PrismaClient

Object.assign(exports, Prisma)
