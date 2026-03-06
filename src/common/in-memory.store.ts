import { randomUUID } from 'crypto';

export type InMemoryRecord = Record<string, any> & { id: string };

export class InMemoryStore {
  private static data: Record<string, InMemoryRecord[]> = {
    appointments: [],
    medicalRecords: [],
    shifts: [],
    orders: [],
    notifications: [],
    videoCalls: [],
    products: [],
    stockMovements: [],
    payments: [],
    medicApprovals: [],
    medicHires: [],
    complaints: [],
    subscriptions: [],
    adminNotifications: [],
    messages: [],
    auditLogs: [],
    emails: [],
    passwordResets: [],
    authOtps: [],
    supportChatRequests: [],
    aiVoiceSessions: [],
    aiVoiceEvents: [],
    aiToolAudits: [],
    pharmacyEvents: [],
    purchaseOrders: [],
    smartAlertRuns: [],
    rolePermissions: [],
    kycReviews: [],
    fraudCases: [],
    supportTickets: [],
    contentPolicies: [],
    policyAcceptances: [],
    emergencyIncidents: [],
    complianceRequests: [],
    featureFlags: [],
    paymentDisputes: [],
    refunds: [],
    withdrawals: [],
    platformHealthSnapshots: [],
  };
  private static profileExtras: Record<string, Record<string, any>> = {};
  private static subscriptionPricing: Record<string, { monthly: number; yearly: number }> = {
    MEDIC: { monthly: 300, yearly: 4800 },
    PHARMACY_ADMIN: { monthly: 500, yearly: 10000 },
    HOSPITAL_ADMIN: { monthly: 1000, yearly: 12000 },
    PATIENT: { monthly: 0, yearly: 0 },
  };

  static create<T extends InMemoryRecord>(collection: keyof typeof InMemoryStore.data, payload: Omit<T, 'id'>) {
    const record = { id: randomUUID(), ...payload } as T;
    InMemoryStore.data[collection].push(record);
    return record;
  }

  static list<T extends InMemoryRecord>(collection: keyof typeof InMemoryStore.data) {
    return InMemoryStore.data[collection] as T[];
  }

  static findById<T extends InMemoryRecord>(collection: keyof typeof InMemoryStore.data, id: string) {
    return (InMemoryStore.data[collection] as T[]).find((item) => item.id === id) || null;
  }

  static update<T extends InMemoryRecord>(collection: keyof typeof InMemoryStore.data, id: string, payload: Partial<T>) {
    const items = InMemoryStore.data[collection] as T[];
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return null;
    items[index] = { ...items[index], ...payload } as T;
    return items[index];
  }

  static remove(collection: keyof typeof InMemoryStore.data, id: string) {
    const items = InMemoryStore.data[collection];
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    items.splice(index, 1);
    return true;
  }

  static getProfileExtras(userId: string) {
    return InMemoryStore.profileExtras[userId] || {};
  }

  static setProfileExtras(userId: string, payload: Record<string, any>) {
    const current = InMemoryStore.profileExtras[userId] || {};
    InMemoryStore.profileExtras[userId] = { ...current, ...payload };
    return InMemoryStore.profileExtras[userId];
  }

  static listProfileExtras() {
    return { ...InMemoryStore.profileExtras };
  }

  static logAudit(payload: Record<string, any>) {
    return InMemoryStore.create('auditLogs', payload);
  }

  static getSubscriptionPricing() {
    return InMemoryStore.subscriptionPricing;
  }

  static setSubscriptionPricing(
    payload: Record<string, { monthly?: number; yearly?: number }>,
  ) {
    Object.entries(payload || {}).forEach(([role, values]) => {
      const current = InMemoryStore.subscriptionPricing[role] || { monthly: 0, yearly: 0 };
      InMemoryStore.subscriptionPricing[role] = {
        monthly: Number(values?.monthly ?? current.monthly),
        yearly: Number(values?.yearly ?? current.yearly),
      };
    });
    return InMemoryStore.subscriptionPricing;
  }
}
