import { Injectable } from '@nestjs/common';
import { InMemoryStore } from 'src/common/in-memory.store';
import { getProfileExtras, getProfileExtrasMap } from 'src/common/profile-extras';
import { PrismaService } from 'src/database/prisma.service';
import { NotificationsGateway } from '../notifications/notifications.gateway';
import { AiService } from './ai.service';

type VoiceContext = {
  userId: string;
  role: string;
};

@Injectable()
export class AiVoiceToolsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: NotificationsGateway,
    private readonly aiService: AiService,
  ) {}

  private normalizeRole(role: unknown) {
    return String(role || '').toUpperCase();
  }

  private toNum(value: unknown, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private distanceKm(aLat: number, aLng: number, bLat: number, bLng: number) {
    const toRad = (n: number) => (n * Math.PI) / 180;
    const dLat = toRad(bLat - aLat);
    const dLng = toRad(bLng - aLng);
    const lat1 = toRad(aLat);
    const lat2 = toRad(bLat);
    const h =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.sin(dLng / 2) * Math.sin(dLng / 2) * Math.cos(lat1) * Math.cos(lat2);
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  private parseLocation(extras: Record<string, any> = {}) {
    const location = extras?.location;
    if (location && typeof location === 'object') {
      const lat = this.toNum((location as any).lat ?? (location as any).latitude, NaN);
      const lng = this.toNum((location as any).lng ?? (location as any).longitude, NaN);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        return {
          lat,
          lng,
          address: (location as any).address || extras.locationAddress || null,
        };
      }
    }
    const lat = this.toNum(extras.locationLat ?? extras.latitude, NaN);
    const lng = this.toNum(extras.locationLng ?? extras.longitude, NaN);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      return { lat, lng, address: extras.locationAddress || null };
    }
    return null;
  }

  async searchMedics(args: any) {
    const result = await this.aiService.smartSearch(
      {
        query: [
          args?.name,
          args?.specialization,
          args?.location,
          args?.availableDay,
          args?.minExperience ? `at least ${args.minExperience} years` : '',
          args?.maxPrice ? `under ${args.maxPrice}` : '',
        ]
          .filter(Boolean)
          .join(' ')
          .trim(),
        include: ['medic'],
        limit: Math.min(Math.max(Number(args?.limit || 8), 1), 20),
      },
      { userId: args?.requesterId, role: args?.requesterRole || 'PATIENT' },
    );
    return result?.results || [];
  }

  async searchHospitals(args: any) {
    const users = await this.prisma.user.findMany({
      where: { role: 'HOSPITAL_ADMIN' },
      select: { id: true, fullName: true, email: true, phone: true },
      take: 500,
    });
    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));
    const query = String(
      [args?.name, args?.location, ...(Array.isArray(args?.services) ? args.services : [])]
        .filter(Boolean)
        .join(' '),
    )
      .trim()
      .toLowerCase();

    let items = users.map((u) => {
      const extras = extrasMap.get(u.id) || {};
      return {
        id: u.id,
        name: extras.hospitalName || u.fullName || u.email || 'Hospital',
        email: u.email,
        phone: u.phone || extras.adminContact || null,
        location: extras.locationAddress || extras.locationTown || extras.county || null,
        services: extras.services || extras.specialties || null,
      };
    });

    if (query) {
      items = items.filter((item) => {
        const haystack = `${item.name} ${item.location || ''} ${item.services || ''}`.toLowerCase();
        return haystack.includes(query);
      });
    }
    return items.slice(0, 20);
  }

  async searchPharmacyProducts(args: any) {
    const products = await (this.prisma as any).product.findMany({
      where: {
        ...(args?.productName
          ? { name: { contains: String(args.productName), mode: 'insensitive' } }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const tenantIds: string[] = Array.from(
      new Set(
        products
          .map((item: any) => item?.pharmacyId)
          .filter((id: any): id is string => typeof id === 'string' && id.trim().length > 0),
      ),
    );
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: tenantIds } },
      select: { id: true, name: true, location: true },
    });
    const tenantUsers = tenantIds.length
      ? await this.prisma.tenantUser.findMany({
          where: { tenantId: { in: tenantIds } },
          select: { tenantId: true, userId: true, isPrimary: true },
        })
      : [];
    const usersByTenant = new Map<string, { tenantId: string; userId: string; isPrimary: boolean }[]>();
    tenantUsers.forEach((row) => {
      const list = usersByTenant.get(row.tenantId) || [];
      list.push(row);
      usersByTenant.set(row.tenantId, list);
    });
    const userIds = Array.from(
      new Set(
        tenantUsers
          .map((item) => item.userId)
          .filter((id): id is string => typeof id === 'string' && id.trim().length > 0),
      ),
    );
    const extrasMap = await getProfileExtrasMap(this.prisma, userIds);
    const tenantMap = new Map<string, any>();
    tenants.forEach((tenant) => {
      const tenantUserRows = usersByTenant.get(tenant.id) || [];
      const primaryUserId =
        tenantUserRows.find((u) => u.isPrimary)?.userId || tenantUserRows[0]?.userId || null;
      const extras = primaryUserId ? extrasMap.get(primaryUserId) || {} : {};
      tenantMap.set(tenant.id, {
        id: tenant.id,
        name: extras.pharmacyName || tenant.name,
        location: extras.locationAddress || extras.locationTown || extras.county || tenant.location,
      });
    });

    const locationQuery = String(args?.location || '').trim().toLowerCase();
    const maxPrice = this.toNum(args?.maxPrice, 0);

    const mapped = products
      .map((product: any) => {
        const pharmacy = tenantMap.get(product.pharmacyId) || { id: product.pharmacyId };
        const stock = this.toNum(product.stock ?? product.numberInStock ?? product.quantity, 0);
        return {
          id: product.id,
          name: product.name || product.productName || 'Product',
          price: this.toNum(product.price, 0),
          stock,
          requiresPrescription: Boolean(
            product.prescriptionRequired ?? product.requiresPrescription ?? false,
          ),
          pharmacy,
          imageUrl: product.imageUrl || product.image || null,
        };
      })
      .filter((item) => (maxPrice > 0 ? item.price <= maxPrice : true))
      .filter((item) =>
        locationQuery
          ? String(item.pharmacy?.location || '').toLowerCase().includes(locationQuery)
          : true,
      );

    return mapped.slice(0, 30);
  }

  async summarizeHealthRecord(args: any, context: VoiceContext) {
    const patientId = String(args?.patientId || context.userId);
    const result = await this.aiService.summarizeHealthStatus(
      {
        patientId,
      },
      { userId: context.userId, role: context.role },
    );
    return result;
  }

  async getEmergencyContacts(args: any, context: VoiceContext) {
    const userId = context.userId;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, phone: true, emergencyContactName: true, emergencyContactPhone: true },
    });
    const extras = await getProfileExtras(this.prisma, userId);
    const saved = [
      user?.emergencyContactPhone
        ? {
            type: 'saved_contact',
            name: user?.emergencyContactName || 'Emergency contact',
            phone: user.emergencyContactPhone,
          }
        : null,
      extras?.emergencyLine
        ? {
            type: 'saved_contact',
            name: 'Emergency line',
            phone: String(extras.emergencyLine),
          }
        : null,
    ].filter(Boolean);

    const lat = this.toNum(args?.userLat ?? args?.lat, NaN);
    const lng = this.toNum(args?.userLng ?? args?.lng, NaN);
    const radiusKm = Math.max(this.toNum(args?.radiusKm, 30), 1);

    const users = await this.prisma.user.findMany({
      where: { role: { in: ['MEDIC', 'HOSPITAL_ADMIN'] } },
      select: { id: true, fullName: true, role: true, phone: true, email: true },
      take: 500,
    });
    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));

    const nearby = users
      .map((item) => {
        const profile = extrasMap.get(item.id) || {};
        const loc = this.parseLocation(profile);
        if (!loc || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
        const distanceKm = this.distanceKm(lat, lng, loc.lat, loc.lng);
        return {
          type: this.normalizeRole(item.role) === 'MEDIC' ? 'medic' : 'hospital',
          id: item.id,
          name: item.fullName || item.email || 'Provider',
          phone: item.phone || null,
          location: loc.address || profile.locationTown || profile.county || null,
          distanceKm: Number(distanceKm.toFixed(2)),
        };
      })
      .filter(Boolean)
      .filter((item: any) => item.distanceKm <= radiusKm)
      .sort((a: any, b: any) => a.distanceKm - b.distanceKm)
      .slice(0, 10);

    return {
      saved,
      nearby,
    };
  }

  async requestSupportChat(args: any, context: VoiceContext) {
    const requesterId = context.userId;
    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
      select: { id: true, fullName: true, email: true, role: true },
    });
    if (!requester) {
      return { success: false, message: 'Requester not found.' };
    }

    const pending = (InMemoryStore.list('supportChatRequests') as any[]).find(
      (item) => item.requesterId === requesterId && item.status === 'PENDING',
    );
    if (pending) {
      return {
        success: true,
        requestId: pending.id,
        status: pending.status,
      };
    }

    const request = InMemoryStore.create('supportChatRequests', {
      requesterId,
      requesterName: requester.fullName || requester.email || 'User',
      requesterRole: requester.role,
      note: String(args?.note || '').trim(),
      status: 'PENDING',
      requestedAt: new Date().toISOString(),
      handledBy: null,
      handledAt: null,
    } as any);

    const admins = await this.prisma.user.findMany({
      where: { role: 'SUPER_ADMIN' },
      select: { id: true, fullName: true, email: true },
      take: 10,
    });
    admins.forEach((admin) => {
      InMemoryStore.create('notifications', {
        userId: admin.id,
        title: 'Support chat request',
        message: `${requester.fullName || requester.email || 'A user'} requested support chat.`,
        type: 'SUPPORT_CHAT_REQUEST',
        relatedId: request.id,
        data: {
          requestId: request.id,
          requesterId,
          requesterName: requester.fullName || requester.email || 'User',
        },
        isRead: false,
        createdAt: new Date().toISOString(),
      });
      this.gateway.emitToUser(admin.id, {
        title: 'Support chat request',
        message: `${requester.fullName || requester.email || 'A user'} requested support chat.`,
        type: 'SUPPORT_CHAT_REQUEST',
        data: { requestId: request.id, requesterId },
      });
    });

    return {
      success: true,
      requestId: request.id,
      status: request.status,
    };
  }
}
