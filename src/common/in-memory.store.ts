import { randomUUID } from 'crypto';

export type InMemoryRecord = Record<string, any> & { id: string };

export class InMemoryStore {
  private static prisma: any | null = null;
  private static hydrated = false;
  private static persistenceEnabled =
    String(process.env.IN_MEMORY_STORE_PERSIST || 'true').toLowerCase() === 'true';
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
    aiConversations: [],
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
    PATIENT: { monthly: 100, yearly: 1200 },
  };

  static configure(prisma: any) {
    InMemoryStore.prisma = prisma;
  }

  static async hydrate(prisma: any) {
    if (!InMemoryStore.persistenceEnabled || InMemoryStore.hydrated) {
      return;
    }
    InMemoryStore.prisma = prisma;
    const collections = new Set(Object.keys(InMemoryStore.data));
    const records = await prisma.inMemoryRecord.findMany({
      where: { collection: { in: Array.from(collections) } },
    });
    Object.keys(InMemoryStore.data).forEach((key) => {
      InMemoryStore.data[key] = [];
    });
    records.forEach((record: any) => {
      const collection = String(record.collection || '');
      if (!collection || !(collection in InMemoryStore.data)) return;
      const payload = record.data && typeof record.data === 'object' ? record.data : {};
      InMemoryStore.data[collection].push({ ...payload, id: record.id });
    });
    InMemoryStore.hydrated = true;
  }

  private static persistCreate(collection: string, record: InMemoryRecord) {
    if (!InMemoryStore.persistenceEnabled || !InMemoryStore.prisma) return;
    const { id, ...payload } = record;
    void InMemoryStore.prisma.inMemoryRecord
      .create({
        data: {
          id,
          collection,
          data: payload,
        },
      })
      .catch(() => undefined);
  }

  private static persistUpdate(collection: string, record: InMemoryRecord) {
    if (!InMemoryStore.persistenceEnabled || !InMemoryStore.prisma) return;
    const { id, ...payload } = record;
    void InMemoryStore.prisma.inMemoryRecord
      .update({
        where: { id },
        data: {
          collection,
          data: payload,
        },
      })
      .catch(() => undefined);
  }

  private static persistRemove(id: string) {
    if (!InMemoryStore.persistenceEnabled || !InMemoryStore.prisma) return;
    void InMemoryStore.prisma.inMemoryRecord
      .delete({ where: { id } })
      .catch(() => undefined);
  }

  static create<T extends InMemoryRecord>(collection: keyof typeof InMemoryStore.data, payload: Omit<T, 'id'>) {
    const record = { id: randomUUID(), ...payload } as T;
    InMemoryStore.data[collection].push(record);
    InMemoryStore.persistCreate(String(collection), record);
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
    InMemoryStore.persistUpdate(String(collection), items[index]);
    return items[index];
  }

  static remove(collection: keyof typeof InMemoryStore.data, id: string) {
    const items = InMemoryStore.data[collection];
    const index = items.findIndex((item) => item.id === id);
    if (index === -1) return false;
    items.splice(index, 1);
    InMemoryStore.persistRemove(id);
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
