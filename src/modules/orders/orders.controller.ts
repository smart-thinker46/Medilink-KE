import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  UseGuards,
  Req,
  Param,
  BadRequestException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import { ensurePharmacyProfileComplete, ensureHospitalProfileComplete } from 'src/common/profile-validation';
import { EmailsService } from '../emails/emails.service';
import { getProfileExtras } from 'src/common/profile-extras';

@Controller('orders')
@UseGuards(AuthGuard('jwt'))
export class OrdersController {
  constructor(private prisma: PrismaService, private emails: EmailsService) {}

  private get db(): any {
    return this.prisma as any;
  }

  private normalizeNumber(value: any, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private async notifyTenantOwners(tenantId: string | null | undefined, payload: any) {
    if (!tenantId) return;
    const owners = await this.prisma.tenantUser.findMany({
      where: { tenantId },
      select: { userId: true },
    });
    const ownerIds = Array.from(new Set(owners.map((owner) => owner.userId).filter(Boolean)));
    ownerIds.forEach((userId) => {
      InMemoryStore.create('notifications', {
        userId,
        title: payload.title,
        message: payload.message,
        type: payload.type || 'ORDER_ACTIVITY',
        data: payload.data || {},
        isRead: false,
        createdAt: new Date().toISOString(),
      });
    });
  }

  @Get()
  async list(@Req() req: any) {
    const role = String(req.user?.role || '').toUpperCase();
    const userId = req.user?.userId;
    const tenantId = req.user?.tenantId;
    const allOrders = InMemoryStore.list('orders');

    if (role === 'SUPER_ADMIN') {
      return allOrders;
    }

    if (role === 'PHARMACY_ADMIN') {
      const ownerIds = new Set([tenantId, userId].filter(Boolean));
      return allOrders.filter((order: any) => ownerIds.has(order?.pharmacyId));
    }

    return allOrders.filter(
      (order: any) =>
        order?.patientId === userId ||
        order?.buyerId === userId ||
        order?.userId === userId,
    );
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const role = String(req.user?.role || '').toUpperCase();
    const buyerId = req.user?.userId;
    const patientId = body.patientId || body.patient_id || buyerId;
    if (role === 'PHARMACY_ADMIN') {
      await ensurePharmacyProfileComplete(this.prisma, req.user?.userId);
    }
    if (role === 'HOSPITAL_ADMIN') {
      await ensureHospitalProfileComplete(this.prisma, req.user?.userId);
    }

    const ownerTenantId = body.pharmacyId || req.user?.tenantId || req.user?.userId;
    const rawItems = Array.isArray(body.items) ? body.items : [];
    if (!rawItems.length) {
      throw new BadRequestException('Order must contain at least one item.');
    }

    const productIds = rawItems
      .map((item) => String(item?.id || '').trim())
      .filter((id) => id.length > 0);
    const products: any[] = productIds.length
      ? await this.db.product.findMany({
          where: { pharmacyId: ownerTenantId, id: { in: productIds } },
        })
      : [];
    const productMap: Map<string, any> = new Map(
      products.map((product: any) => [String(product.id), product]),
    );

    const normalizedItems = rawItems.map((item) => {
      const productId = String(item?.id || '').trim();
      const product: any = productMap.get(productId);
      const quantity = Math.max(1, Math.floor(this.normalizeNumber(item?.quantity, 1)));
      const availableStock = this.normalizeNumber(
        product?.stock ?? product?.numberInStock ?? product?.quantity,
        0,
      );
      if (!product) {
        throw new BadRequestException(`Product not found in selected inventory: ${productId}`);
      }
      if (quantity > availableStock) {
        throw new BadRequestException(
          `${product?.name || product?.productName || 'Product'} has insufficient stock.`,
        );
      }
      const unitPrice = this.normalizeNumber(item?.price, this.normalizeNumber(product?.price, 0));
      return {
        id: productId,
        name: item?.name || product?.name || product?.productName || 'Product',
        quantity,
        price: unitPrice,
        prescriptionRequired: Boolean(
          item?.prescriptionRequired ?? product?.prescriptionRequired ?? product?.requiresPrescription,
        ),
      };
    });
    const computedTotal = normalizedItems.reduce(
      (sum, item) => sum + this.normalizeNumber(item.price, 0) * this.normalizeNumber(item.quantity, 0),
      0,
    );
    const requiresPrescription = normalizedItems.some((item) => Boolean(item?.prescriptionRequired));

    const requestedPrescriptionId = String(body.prescriptionId || '').trim();
    if (requiresPrescription && role === 'PATIENT' && !requestedPrescriptionId) {
      throw new BadRequestException(
        'This order contains prescription-only medicine. Attach a valid prescription.',
      );
    }

    let prescriptionRecord: any = null;
    if (requestedPrescriptionId) {
      prescriptionRecord = await this.prisma.medicalRecord.findFirst({
        where: {
          id: requestedPrescriptionId,
          patientId,
          type: 'prescription',
        },
        include: {
          medic: { select: { id: true, fullName: true } },
        },
      });
      if (!prescriptionRecord) {
        throw new BadRequestException('Invalid prescription selected for this patient.');
      }
    }

    if (productIds.length) {
      await this.prisma.$transaction(
        normalizedItems.map((item) => {
          const product: any = productMap.get(item.id);
          const stockBefore = this.normalizeNumber(
            product?.stock ?? product?.numberInStock ?? product?.quantity,
            0,
          );
          const stockAfter = Math.max(0, stockBefore - item.quantity);
          return this.db.product.update({
            where: { id: item.id },
            data: {
              quantity: stockAfter,
              stock: stockAfter,
              numberInStock: stockAfter,
            },
          });
        }),
      );

      await Promise.all(
        normalizedItems.map((item) => {
          const product: any = productMap.get(item.id);
          const stockBefore = this.normalizeNumber(
            product?.stock ?? product?.numberInStock ?? product?.quantity,
            0,
          );
          const stockAfter = Math.max(0, stockBefore - item.quantity);
          return this.db.stockMovement.create({
            data: {
              pharmacyId: ownerTenantId,
              productId: item.id,
              productName: item.name,
              type: 'SALE',
              quantityChange: -item.quantity,
              stockBefore,
              stockAfter,
              reason: 'Order checkout',
              actorId: req.user?.userId,
            },
          });
        }),
      );
    }

    const record = InMemoryStore.create('orders', {
      patientId,
      buyerId,
      buyerRole: role,
      items: normalizedItems,
      total: computedTotal || this.normalizeNumber(body.total, 0),
      currency: body.currency || 'KES',
      notes: body.notes,
      requiresPrescription,
      prescriptionId: prescriptionRecord?.id || null,
      prescription: prescriptionRecord
        ? {
            id: prescriptionRecord.id,
            issuedAt: prescriptionRecord.createdAt,
            notes: prescriptionRecord.notes || '',
            medicId: prescriptionRecord.medicId,
            medicName: prescriptionRecord.medic?.fullName || 'Medic',
          }
        : null,
      status: 'PENDING',
      pharmacyId: ownerTenantId,
      createdAt: new Date().toISOString(),
    });
    InMemoryStore.create('pharmacyEvents', {
      pharmacyId: ownerTenantId,
      type: 'CHECKOUT_START',
      userId: buyerId || patientId || null,
      orderId: record.id,
      metadata: {
        itemCount: normalizedItems.length,
        total: record.total,
        currency: record.currency,
      },
      createdAt: new Date().toISOString(),
    });
    const [patient, pharmacy] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: record.patientId }, select: { email: true, fullName: true } }),
      this.prisma.tenant.findUnique({ where: { id: record.pharmacyId }, select: { email: true, name: true } }),
    ]);
    const subject = 'Order Confirmation';
    if (patient?.email) {
      const locale = ((await getProfileExtras(this.prisma, record.patientId))?.language || 'en') as 'en' | 'sw';
      await this.emails
        .sendTransactional({
          to: patient.email,
          subject: this.emails.t(locale, 'order_confirmed_title'),
          html: this.emails.buildBrandedHtml({
            title: this.emails.t(locale, 'order_confirmed_title'),
            body: `<p>${this.emails.t(locale, 'order_confirmed_body')}</p><p>Total: ${record.currency} ${record.total}.</p>`,
            locale,
          }),
          text: `${this.emails.t(locale, 'order_confirmed_body')} Total: ${record.currency} ${record.total}.`,
        })
        .catch(() => undefined);
    }
    if (pharmacy?.email) {
      const locale = ((await getProfileExtras(this.prisma, record.pharmacyId))?.language || 'en') as 'en' | 'sw';
      await this.emails
        .sendOrderReceived({
          to: pharmacy.email,
          orderId: record.id,
          total: record.total,
          currency: record.currency,
          locale,
        })
        .catch(() => undefined);
    }

    await this.notifyTenantOwners(record.pharmacyId, {
      title: 'New purchase/sale',
      message: `A new order (${record.id}) was placed. Total: ${record.currency} ${record.total}.`,
      type: 'ORDER_ACTIVITY',
      data: { orderId: record.id, total: record.total, currency: record.currency },
    });

    return record;
  }

  @Put(':id')
  async update(@Param('id') id: string, @Body() body: any) {
    const updated = InMemoryStore.update('orders', id, body);
    if (updated) {
      const status = String(updated.status || '').toUpperCase();
      if (['COMPLETED', 'APPROVED', 'PAID', 'DELIVERED'].includes(status)) {
        InMemoryStore.create('pharmacyEvents', {
          pharmacyId: updated.pharmacyId,
          type: 'CHECKOUT_COMPLETE',
          userId: updated.buyerId || updated.patientId || null,
          orderId: updated.id,
          metadata: {
            status,
            total: updated.total,
            currency: updated.currency,
          },
          createdAt: new Date().toISOString(),
        });
      }
      const [patient, pharmacy] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: updated.patientId }, select: { email: true } }),
        this.prisma.tenant.findUnique({ where: { id: updated.pharmacyId }, select: { email: true } }),
      ]);
      const subject = 'Order Status Update';
      const statusText = `Status: ${updated.status || '-'}`;
      if (patient?.email) {
        const locale = ((await getProfileExtras(this.prisma, updated.patientId))?.language || 'en') as 'en' | 'sw';
        await this.emails
          .sendTransactional({
            to: patient.email,
            subject: this.emails.t(locale, 'order_update_title'),
            html: this.emails.buildBrandedHtml({
              title: this.emails.t(locale, 'order_update_title'),
              body: `<p>${this.emails.t(locale, 'order_update_body')}</p><p>${statusText}</p>`,
              locale,
            }),
            text: `${this.emails.t(locale, 'order_update_body')} ${statusText}`,
          })
          .catch(() => undefined);
      }
      if (pharmacy?.email) {
        const locale = ((await getProfileExtras(this.prisma, updated.pharmacyId))?.language || 'en') as 'en' | 'sw';
        await this.emails
          .sendTransactional({
            to: pharmacy.email,
            subject: this.emails.t(locale, 'order_update_title'),
            html: this.emails.buildBrandedHtml({
              title: this.emails.t(locale, 'order_update_title'),
              body: `<p>${this.emails.t(locale, 'order_update_body')}</p><p>${statusText}</p>`,
              locale,
            }),
            text: `${this.emails.t(locale, 'order_update_body')} ${statusText}`,
          })
          .catch(() => undefined);
      }
    }
    return updated;
  }
}
