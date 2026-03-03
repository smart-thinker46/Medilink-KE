import { Controller, Get, Post, Put, Delete, Param, Body, UseGuards, Req, Query, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import { ensurePharmacyProfileComplete, ensureHospitalProfileComplete } from 'src/common/profile-validation';
import { getProfileExtras, getProfileExtrasMap } from 'src/common/profile-extras';

@Controller('pharmacy')
@UseGuards(AuthGuard('jwt'))
export class PharmacyController {
  constructor(private prisma: PrismaService) {}

  private get db(): any {
    return this.prisma as any;
  }

  private async assertInventoryAccess(
    userId: string | undefined,
    tenantId: string,
    role?: string,
  ) {
    if (!userId) {
      throw new ForbiddenException('User is not authenticated.');
    }
    const normalizedRole = String(role || '').toUpperCase();

    if (normalizedRole === 'SUPER_ADMIN') {
      const tenant = await this.prisma.tenant.findFirst({
        where: {
          id: tenantId,
          type: { in: ['PHARMACY', 'HOSPITAL'] },
        },
      });
      if (!tenant) {
        throw new ForbiddenException('Inventory tenant not found.');
      }
      return { userId, tenantId, tenant } as any;
    }

    const access = await this.prisma.tenantUser.findFirst({
      where: {
        userId,
        tenantId,
        tenant: {
          type: { in: ['PHARMACY', 'HOSPITAL'] },
        },
      },
      include: { tenant: true },
    });
    if (!access) {
      throw new ForbiddenException('You are not allowed to access this inventory.');
    }
    return access;
  }

  private async ensureInventoryProfileComplete(
    userId: string | undefined,
    tenantType: 'PHARMACY' | 'HOSPITAL',
  ) {
    if (!userId) {
      throw new ForbiddenException('User is not authenticated.');
    }
    if (tenantType === 'PHARMACY') {
      await ensurePharmacyProfileComplete(this.prisma, userId);
      return;
    }
    await ensureHospitalProfileComplete(this.prisma, userId);
  }

  private async getPharmacyScope(pharmacyId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: pharmacyId },
      include: { users: true },
    });
    const primaryLink =
      tenant?.users?.find((link: any) => link.isPrimary) || tenant?.users?.[0];
    const primaryUserId = primaryLink?.userId || null;
    return {
      tenant,
      primaryUserId,
      orderOwnerIds: [pharmacyId, primaryUserId].filter(Boolean) as string[],
    };
  }

  private normalizeNumber(value: any, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private normalizeBoolean(value: any) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      return normalized === 'true' || normalized === 'yes' || normalized === '1';
    }
    if (typeof value === 'number') return value === 1;
    return false;
  }

  private normalizeDate(value: any) {
    if (!value) return null;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  private parseAnalyticsRange(startDate?: string, endDate?: string, preset?: string) {
    let start: Date | null = null;
    let end: Date | null = null;

    const now = new Date();
    const normalizedPreset = String(preset || '').trim().toLowerCase();

    if (normalizedPreset === 'today') {
      start = new Date(now);
      start.setHours(0, 0, 0, 0);
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
    } else if (normalizedPreset === '7d') {
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
      start = new Date(now);
      start.setDate(now.getDate() - 6);
      start.setHours(0, 0, 0, 0);
    } else if (normalizedPreset === '30d') {
      end = new Date(now);
      end.setHours(23, 59, 59, 999);
      start = new Date(now);
      start.setDate(now.getDate() - 29);
      start.setHours(0, 0, 0, 0);
    }

    if (startDate) {
      const parsedStart = new Date(startDate);
      if (!Number.isNaN(parsedStart.getTime())) {
        start = parsedStart;
        start.setHours(0, 0, 0, 0);
      }
    }
    if (endDate) {
      const parsedEnd = new Date(endDate);
      if (!Number.isNaN(parsedEnd.getTime())) {
        end = parsedEnd;
        end.setHours(23, 59, 59, 999);
      }
    }

    return { start, end };
  }

  private isWithinRange(value: any, start: Date | null, end: Date | null) {
    if (!start && !end) return true;
    if (!value) return false;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return false;
    if (start && date < start) return false;
    if (end && date > end) return false;
    return true;
  }

  private normalizeProductPayload(body: any, pharmacyId: string) {
    const quantity = this.normalizeNumber(body?.quantity ?? body?.stock, 0);
    const stock = this.normalizeNumber(body?.stock ?? body?.quantity, quantity);
    const price = this.normalizeNumber(body?.price, 0);

    return {
      pharmacyId,
      name: String(body?.name ?? body?.productName ?? '').trim(),
      productName: String(body?.name ?? body?.productName ?? '').trim(),
      manufacturer: String(body?.manufacturer ?? '').trim(),
      batchNumber: String(body?.batchNumber ?? body?.batch ?? '').trim(),
      description: String(body?.description ?? '').trim(),
      category: String(body?.category ?? '').trim(),
      prescriptionRequired: this.normalizeBoolean(
        body?.prescriptionRequired ?? body?.requiresPrescription ?? body?.prescription,
      ),
      requiresPrescription: this.normalizeBoolean(
        body?.prescriptionRequired ?? body?.requiresPrescription ?? body?.prescription,
      ),
      quantity,
      stock,
      numberInStock: stock,
      price,
      expiryDate: this.normalizeDate(body?.expiryDate),
      sku: String(body?.sku ?? body?.barcode ?? body?.productCode ?? '').trim(),
      barcode: String(body?.barcode ?? body?.sku ?? '').trim(),
      reorderLevel: this.normalizeNumber(body?.reorderLevel, 5),
      imageUrl: body?.imageUrl || body?.image || body?.photoUrl || null,
    };
  }

  private daysUntil(dateValue: any) {
    if (!dateValue) return null;
    const expiry = new Date(dateValue);
    if (Number.isNaN(expiry.getTime())) return null;
    const diff = expiry.getTime() - Date.now();
    return Math.ceil(diff / (1000 * 60 * 60 * 24));
  }

  private createAlertNotifications(opts: {
    userId?: string;
    product: any;
    previousStock?: number | null;
  }) {
    const { userId, product, previousStock = null } = opts;
    if (!userId || !product) return;

    const stock = this.normalizeNumber(
      product.stock ?? product.numberInStock ?? product.quantity,
      0,
    );
    const threshold = this.normalizeNumber(product.reorderLevel, 5);
    const shouldAlertLowStock = previousStock === null
      ? stock <= threshold
      : previousStock > threshold && stock <= threshold;

    if (shouldAlertLowStock) {
      InMemoryStore.create('notifications', {
        userId,
        title: 'Low stock alert',
        message: `${product.name || product.productName || 'Product'} is low in stock (${stock} left).`,
        type: 'WARNING',
        data: { productId: product.id, stock, threshold },
        isRead: false,
        createdAt: new Date().toISOString(),
      });
    }

    const days = this.daysUntil(product.expiryDate);
    if (days !== null && days <= 30) {
      InMemoryStore.create('notifications', {
        userId,
        title: 'Expiry alert',
        message:
          days < 0
            ? `${product.name || product.productName || 'Product'} has expired.`
            : `${product.name || product.productName || 'Product'} expires in ${days} day(s).`,
        type: days < 0 ? 'ERROR' : 'WARNING',
        data: { productId: product.id, expiryDate: product.expiryDate, daysUntilExpiry: days },
        isRead: false,
        createdAt: new Date().toISOString(),
      });
    }
  }

  private async logStockMovement(payload: any) {
    return this.db.stockMovement.create({
      data: {
      ...payload,
      },
    });
  }

  private async notifyInventoryOwners(tenantId: string, payload: any) {
    const owners = await this.prisma.tenantUser.findMany({
      where: { tenantId },
      select: { userId: true },
    });
    const uniqueOwnerIds = Array.from(
      new Set(owners.map((owner) => owner.userId).filter(Boolean)),
    );
    uniqueOwnerIds.forEach((userId) => {
      InMemoryStore.create('notifications', {
        userId,
        title: payload.title,
        message: payload.message,
        type: payload.type || 'PHARMACY_ALERT',
        data: payload.data || {},
        isRead: false,
        createdAt: new Date().toISOString(),
      });
    });
  }

  private calculateAutoReorderSuggestions(
    products: any[],
    demandByProduct: Record<string, number>,
    daysInRange: number,
  ) {
    return products
      .map((product) => {
        const id = String(product?.id || '');
        const stock = this.normalizeNumber(
          product?.stock ?? product?.numberInStock ?? product?.quantity,
          0,
        );
        const reorderLevel = this.normalizeNumber(product?.reorderLevel, 5);
        const sold = this.normalizeNumber(demandByProduct[id], 0);
        const avgDailyDemand = sold / Math.max(daysInRange, 1);
        const forecast7d = Math.ceil(avgDailyDemand * 7);
        const projectedStockOutDays =
          avgDailyDemand > 0 ? Math.floor(stock / avgDailyDemand) : null;
        const recommendedQty = Math.max(
          0,
          reorderLevel * 2 - stock,
          forecast7d - stock,
        );
        const priorityScore =
          (stock <= reorderLevel ? 2 : 0) +
          ((projectedStockOutDays ?? 999) <= 7 ? 2 : 0) +
          (forecast7d > stock ? 1 : 0);
        return {
          productId: id,
          name: product?.name || product?.productName || 'Product',
          category: product?.category || 'General',
          stock,
          reorderLevel,
          avgDailyDemand: Number(avgDailyDemand.toFixed(2)),
          forecast7d,
          projectedStockOutDays,
          recommendedQty,
          unitPrice: this.normalizeNumber(product?.price, 0),
          priority: priorityScore >= 4 ? 'HIGH' : priorityScore >= 2 ? 'MEDIUM' : 'LOW',
          priorityScore,
        };
      })
      .filter((item) => item.recommendedQty > 0 || item.stock <= item.reorderLevel)
      .sort((a, b) => b.priorityScore - a.priorityScore || b.recommendedQty - a.recommendedQty)
      .slice(0, 30);
  }

  private buildSmartAlertItems(input: {
    pharmacyId: string;
    lowStockProducts: any[];
    expiringProducts: any[];
    demandSpikes: any[];
    failedPayments: any[];
  }) {
    const alerts: any[] = [];
    const { pharmacyId, lowStockProducts, expiringProducts, demandSpikes, failedPayments } = input;

    if (lowStockProducts.length) {
      alerts.push({
        key: `low-stock-${new Date().toISOString().slice(0, 10)}`,
        title: 'Low stock products',
        message: `${lowStockProducts.length} products need restocking.`,
        type: 'WARNING',
        data: {
          pharmacyId,
          type: 'LOW_STOCK',
          count: lowStockProducts.length,
          productIds: lowStockProducts.map((item) => item.productId),
        },
      });
    }
    if (expiringProducts.length) {
      alerts.push({
        key: `expiring-${new Date().toISOString().slice(0, 10)}`,
        title: 'Expiry warning',
        message: `${expiringProducts.length} products are expiring soon.`,
        type: 'WARNING',
        data: {
          pharmacyId,
          type: 'EXPIRY',
          count: expiringProducts.length,
          productIds: expiringProducts.map((item) => item.productId),
        },
      });
    }
    if (demandSpikes.length) {
      alerts.push({
        key: `demand-spike-${new Date().toISOString().slice(0, 10)}`,
        title: 'Demand spike detected',
        message: `${demandSpikes.length} products have sudden demand increase.`,
        type: 'INFO',
        data: {
          pharmacyId,
          type: 'DEMAND_SPIKE',
          count: demandSpikes.length,
          productIds: demandSpikes.map((item) => item.productId),
        },
      });
    }
    if (failedPayments.length) {
      alerts.push({
        key: `failed-payments-${new Date().toISOString().slice(0, 10)}`,
        title: 'Failed order payments',
        message: `${failedPayments.length} order payments failed recently.`,
        type: 'ERROR',
        data: {
          pharmacyId,
          type: 'FAILED_PAYMENTS',
          count: failedPayments.length,
          paymentIds: failedPayments.map((item) => item.id),
        },
      });
    }
    return alerts;
  }

  @Get('marketplace')
  async marketplace(
    @Query('search') search?: string,
    @Query('category') category?: string,
    @Query('location') location?: string,
  ) {
    const products = await this.db.product.findMany();
    const tenants = await this.prisma.tenant.findMany({
      where: { type: 'PHARMACY' },
      include: { users: { include: { user: true } } },
    });

    const tenantUserIds = tenants
      .map((tenant) => {
        const primaryLink = tenant.users?.find((link) => link.isPrimary) || tenant.users?.[0];
        return primaryLink?.userId;
      })
      .filter(Boolean) as string[];
    const extrasMap = await getProfileExtrasMap(this.prisma, tenantUserIds);

    const tenantMap = new Map<string, any>();
    tenants.forEach((tenant) => {
      const primaryLink = tenant.users?.find((link) => link.isPrimary) || tenant.users?.[0];
      const userId = primaryLink?.userId;
      const extras = userId ? extrasMap.get(userId) || {} : {};

      tenantMap.set(tenant.id, {
        id: tenant.id,
        name: extras.pharmacyName || tenant.name,
        location: extras.locationAddress || extras.location || tenant.location,
        phone: tenant.phone,
        email: tenant.email,
        status: tenant.status,
        subscriptionStatus: tenant.subscriptionStatus,
      });
    });

    let mappedProducts: any[] = products.map((product) => {
      const pharmacy = tenantMap.get(product.pharmacyId) || {
        id: product.pharmacyId,
        name: 'Pharmacy',
      };
      return {
        ...product,
        pharmacy,
      };
    });

    if (search) {
      const value = search.toLowerCase();
      mappedProducts = mappedProducts.filter(
        (product) =>
          String(product.name || '').toLowerCase().includes(value) ||
          String(product.description || '').toLowerCase().includes(value),
      );
    }
    if (category) {
      const value = category.toLowerCase();
      mappedProducts = mappedProducts.filter((product) =>
        String(product.category || '').toLowerCase().includes(value),
      );
    }
    if (location) {
      const value = location.toLowerCase();
      mappedProducts = mappedProducts.filter((product) =>
        String(product.pharmacy?.location || '').toLowerCase().includes(value),
      );
    }

    return {
      products: mappedProducts,
      pharmacies: Array.from(tenantMap.values()),
    };
  }

  @Get('products/:productId')
  async getProductById(@Param('productId') productId: string) {
    const product = await this.db.product.findUnique({
      where: { id: productId },
    });
    if (!product) return null;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: product.pharmacyId },
      include: { users: { include: { user: true } } },
    });
    const primaryLink = tenant?.users?.find((link) => link.isPrimary) || tenant?.users?.[0];
    const userId = primaryLink?.userId;
    const extras = userId ? await getProfileExtras(this.prisma, userId) : {};
    const pharmacy = tenant
      ? {
          id: tenant.id,
          name: extras.pharmacyName || tenant.name,
          location: extras.locationAddress || extras.location || tenant.location,
          phone: tenant.phone,
          email: tenant.email,
          status: tenant.status,
          subscriptionStatus: tenant.subscriptionStatus,
        }
      : { id: product.pharmacyId, name: 'Pharmacy' };

    return { ...product, pharmacy };
  }

  @Get(':id/products')
  async listProducts(@Req() req: any, @Param('id') pharmacyId: string) {
    await this.assertInventoryAccess(req.user?.userId, pharmacyId, req.user?.role);
    return this.db.product.findMany({
      where: { pharmacyId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  @Get(':id/stock-movements')
  async listStockMovements(@Req() req: any, @Param('id') pharmacyId: string, @Query('productId') productId?: string) {
    await this.assertInventoryAccess(req.user?.userId, pharmacyId, req.user?.role);
    return this.db.stockMovement.findMany({
      where: {
        pharmacyId,
        ...(productId ? { productId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  @Post(':id/events')
  async trackPharmacyEvent(@Req() req: any, @Param('id') pharmacyId: string, @Body() body: any) {
    const type = String(body?.type || '').trim().toUpperCase();
    if (!type) return { success: false, reason: 'missing_type' };

    const allowedTypes = new Set([
      'PRODUCT_VIEW',
      'CART_ADD',
      'CART_REMOVE',
      'CHECKOUT_START',
      'CHECKOUT_COMPLETE',
      'SEARCH',
    ]);
    if (!allowedTypes.has(type)) {
      return { success: false, reason: 'invalid_type' };
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: {
        id: pharmacyId,
        type: { in: ['PHARMACY', 'HOSPITAL'] },
      },
      select: { id: true },
    });
    if (!tenant) {
      return { success: false, reason: 'invalid_pharmacy' };
    }

    const metadata =
      body?.metadata && typeof body.metadata === 'object' ? body.metadata : {};

    const event = InMemoryStore.create('pharmacyEvents', {
      pharmacyId,
      type,
      userId: req.user?.userId || null,
      orderId: body?.orderId || null,
      productId: body?.productId || null,
      metadata,
      createdAt: new Date().toISOString(),
    });
    return { success: true, event };
  }

  @Get(':id/reorder-draft')
  async getReorderDraft(
    @Req() req: any,
    @Param('id') pharmacyId: string,
    @Query('preset') preset?: string,
  ) {
    await this.assertInventoryAccess(req.user?.userId, pharmacyId, req.user?.role);
    const scope = await this.getPharmacyScope(pharmacyId);
    const range = this.parseAnalyticsRange(undefined, undefined, preset || '30d');

    const [products, stockMovements] = await Promise.all([
      this.db.product.findMany({ where: { pharmacyId } }),
      this.db.stockMovement.findMany({ where: { pharmacyId } }),
    ]);

    const soldMovements = stockMovements.filter((movement: any) => {
      if (!this.isWithinRange(movement?.createdAt, range.start, range.end)) return false;
      const type = String(movement?.type || '').toUpperCase();
      const delta = Number(movement?.quantityChange || 0);
      return type === 'SALE' || delta < 0;
    });

    const soldByProduct = soldMovements.reduce((acc: Record<string, number>, movement: any) => {
      const key = String(movement?.productId || '');
      if (!key) return acc;
      acc[key] = (acc[key] || 0) + Math.abs(Number(movement?.quantityChange || 0));
      return acc;
    }, {});

    const daysInRange = Math.max(
      1,
      Math.ceil(
        ((range.end?.getTime() || Date.now()) - (range.start?.getTime() || Date.now() - 29 * 86400000)) /
          86400000,
      ),
    );
    const suggestions = this.calculateAutoReorderSuggestions(products, soldByProduct, daysInRange);
    const totalEstimatedCost = suggestions.reduce(
      (sum, item) => sum + this.normalizeNumber(item.unitPrice, 0) * this.normalizeNumber(item.recommendedQty, 0),
      0,
    );

    return {
      pharmacyId,
      ownerIds: scope.orderOwnerIds,
      suggestions,
      summary: {
        itemCount: suggestions.length,
        totalUnits: suggestions.reduce((sum, item) => sum + this.normalizeNumber(item.recommendedQty, 0), 0),
        estimatedCost: totalEstimatedCost,
        currency: 'KES',
      },
      generatedAt: new Date().toISOString(),
    };
  }

  @Post(':id/reorder-draft')
  async createReorderDraft(
    @Req() req: any,
    @Param('id') pharmacyId: string,
    @Body() body: any,
  ) {
    await this.assertInventoryAccess(req.user?.userId, pharmacyId, req.user?.role);
    const generated = await this.getReorderDraft(req, pharmacyId, body?.preset || '30d');
    const selectedIds = Array.isArray(body?.productIds)
      ? new Set(body.productIds.map((id: any) => String(id)))
      : null;
    const items = (generated.suggestions || []).filter((item: any) =>
      selectedIds ? selectedIds.has(String(item.productId)) : true,
    );
    const total = items.reduce(
      (sum: number, item: any) =>
        sum +
        this.normalizeNumber(item.unitPrice, 0) * this.normalizeNumber(item.recommendedQty, 0),
      0,
    );

    const draft = InMemoryStore.create('purchaseOrders', {
      pharmacyId,
      createdBy: req.user?.userId || null,
      status: 'DRAFT',
      title: body?.title || `Auto reorder ${new Date().toISOString().slice(0, 10)}`,
      notes: body?.notes || null,
      items,
      total,
      currency: 'KES',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await this.notifyInventoryOwners(pharmacyId, {
      title: 'Auto reorder draft created',
      message: `A reorder draft with ${items.length} items is ready for supplier processing.`,
      type: 'INFO',
      data: { draftId: draft.id, total, itemCount: items.length, pharmacyId },
    });

    return { success: true, draft };
  }

  @Post(':id/smart-alerts/run')
  async runSmartAlerts(@Req() req: any, @Param('id') pharmacyId: string) {
    await this.assertInventoryAccess(req.user?.userId, pharmacyId, req.user?.role);
    const scope = await this.getPharmacyScope(pharmacyId);
    const scopeOrderIds = new Set(
      (InMemoryStore.list('orders') as any[])
        .filter((order) => scope.orderOwnerIds.includes(String(order?.pharmacyId || '')))
        .map((order) => String(order?.id || ''))
        .filter(Boolean),
    );
    const products = await this.db.product.findMany({ where: { pharmacyId } });
    const lowStockProducts = products
      .map((product: any) => ({
        productId: product.id,
        name: product.name || product.productName || 'Product',
        stock: this.normalizeNumber(product.stock ?? product.numberInStock ?? product.quantity, 0),
        reorderLevel: this.normalizeNumber(product.reorderLevel, 5),
      }))
      .filter((item) => item.stock <= item.reorderLevel);
    const expiringProducts = products
      .map((product: any) => ({
        productId: product.id,
        name: product.name || product.productName || 'Product',
        daysUntilExpiry: this.daysUntil(product.expiryDate),
      }))
      .filter((item) => item.daysUntilExpiry !== null && item.daysUntilExpiry <= 30);

    const failedPayments = (InMemoryStore.list('payments') as any[]).filter(
      (payment) =>
        scopeOrderIds.has(String(payment?.orderId || '')) &&
        String(payment?.status || '').toUpperCase() === 'FAILED' &&
        this.isWithinRange(payment?.createdAt, new Date(Date.now() - 7 * 86400000), new Date()),
    );

    const alerts = this.buildSmartAlertItems({
      pharmacyId,
      lowStockProducts,
      expiringProducts,
      demandSpikes: [],
      failedPayments,
    });

    const run = InMemoryStore.create('smartAlertRuns', {
      pharmacyId,
      createdBy: req.user?.userId || null,
      alertsGenerated: alerts.length,
      createdAt: new Date().toISOString(),
    });

    await Promise.all(
      alerts.map((alert) =>
        this.notifyInventoryOwners(pharmacyId, {
          title: alert.title,
          message: alert.message,
          type: alert.type,
          data: { ...alert.data, runId: run.id, alertKey: alert.key },
        }),
      ),
    );

    return {
      success: true,
      runId: run.id,
      alertsGenerated: alerts.length,
      alerts,
    };
  }

  @Get(':id/analytics')
  async analytics(
    @Req() req: any,
    @Param('id') pharmacyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('preset') preset?: string,
  ) {
    await this.assertInventoryAccess(req.user?.userId, pharmacyId, req.user?.role);
    const scope = await this.getPharmacyScope(pharmacyId);
    const range = this.parseAnalyticsRange(startDate, endDate, preset);

    const [products, stockMovements] = await Promise.all([
      this.db.product.findMany({ where: { pharmacyId } }),
      this.db.stockMovement.findMany({ where: { pharmacyId } }),
    ]);
    const allOrders = (InMemoryStore.list('orders') as any[]).filter((order) =>
      scope.orderOwnerIds.includes(String(order?.pharmacyId || '')),
    );
    const orders = allOrders.filter((order) =>
      this.isWithinRange(order?.createdAt, range.start, range.end),
    );
    const filteredMovements = stockMovements.filter((movement: any) => {
      return this.isWithinRange(movement?.createdAt, range.start, range.end);
    });

    const normalizeStatus = (status: any) =>
      String(status || 'PENDING').trim().toUpperCase();
    const completedStatuses = new Set(['COMPLETED', 'APPROVED', 'PAID', 'DELIVERED']);
    const pendingStatuses = new Set(['PENDING', 'PROCESSING', 'OPEN']);
    const cancelledStatuses = new Set(['CANCELLED', 'CANCELED', 'DECLINED', 'REJECTED']);

    const orderStats = orders.reduce(
      (acc, order) => {
        const status = normalizeStatus(order?.status);
        const total = Number(order?.total || 0);
        acc.totalOrders += 1;
        if (completedStatuses.has(status)) {
          acc.completedOrders += 1;
          acc.moneyFromSales += total;
        } else if (cancelledStatuses.has(status)) {
          acc.cancelledOrders += 1;
        } else if (pendingStatuses.has(status)) {
          acc.pendingOrders += 1;
        } else {
          acc.pendingOrders += 1;
        }
        return acc;
      },
      {
        totalOrders: 0,
        completedOrders: 0,
        pendingOrders: 0,
        cancelledOrders: 0,
        moneyFromSales: 0,
      },
    );

    const productStats = products.reduce(
      (acc, product) => {
        const stock = this.normalizeNumber(
          product?.stock ?? product?.numberInStock ?? product?.quantity,
          0,
        );
        const reorderLevel = this.normalizeNumber(product?.reorderLevel, 5);
        acc.totalProducts += 1;
        if (stock <= 0) acc.outOfStock += 1;
        if (stock > 0 && stock <= reorderLevel) acc.lowStock += 1;
        return acc;
      },
      { totalProducts: 0, lowStock: 0, outOfStock: 0 },
    );

    const soldMovements = filteredMovements.filter((movement: any) => {
      const type = String(movement?.type || '').toUpperCase();
      const delta = Number(movement?.quantityChange || 0);
      return type === 'SALE' || delta < 0;
    });

    const soldProducts = soldMovements.reduce((sum: number, movement: any) => {
      const delta = Number(movement?.quantityChange || 0);
      return sum + Math.abs(delta);
    }, 0);

    const soldByProduct = soldMovements.reduce((acc: Record<string, number>, movement: any) => {
      const key = String(movement?.productId || movement?.productName || '');
      if (!key) return acc;
      const delta = Math.abs(Number(movement?.quantityChange || 0));
      acc[key] = (acc[key] || 0) + delta;
      return acc;
    }, {});

    const productNameById = new Map(
      products.map((product: any) => [product.id, product.name || product.productName || product.id]),
    );
    const topSoldProducts = Object.entries(soldByProduct)
      .map(([key, quantity]) => ({
        productId: key,
        productName: productNameById.get(key) || key,
        quantity,
        imageUrl: products.find((p: any) => String(p.id) === String(key))?.imageUrl || null,
      }))
      .sort((a, b) => Number(b.quantity) - Number(a.quantity))
      .slice(0, 6);

    const daysInRange = Math.max(
      1,
      Math.ceil(
        ((range.end?.getTime() || Date.now()) -
          (range.start?.getTime() || Date.now() - 29 * 24 * 60 * 60 * 1000)) /
          (24 * 60 * 60 * 1000),
      ),
    );

    const ordersByProduct: Record<string, number> = {};
    const orderItems = orders.flatMap((order) => {
      const items = Array.isArray(order?.items) ? order.items : [];
      return items.map((item: any) => {
        const productId = String(item?.id || item?.productId || '');
        const quantity = this.normalizeNumber(item?.quantity, 0);
        if (productId) {
          ordersByProduct[productId] = (ordersByProduct[productId] || 0) + quantity;
        }
        return {
          ...item,
          productId,
          quantity,
          orderId: order?.id,
          createdAt: order?.createdAt,
          buyerId: order?.buyerId || order?.patientId || null,
          status: normalizeStatus(order?.status),
          total: this.normalizeNumber(order?.total, 0),
        };
      });
    });

    const autoReorder = this.calculateAutoReorderSuggestions(
      products,
      ordersByProduct,
      daysInRange,
    );

    const demandForecast = products
      .map((product: any) => {
        const productId = String(product?.id || '');
        const soldUnits = this.normalizeNumber(ordersByProduct[productId], 0);
        const avgDailyDemand = soldUnits / daysInRange;
        const forecast7d = Math.ceil(avgDailyDemand * 7);
        const forecast30d = Math.ceil(avgDailyDemand * 30);
        const stock = this.normalizeNumber(
          product?.stock ?? product?.numberInStock ?? product?.quantity,
          0,
        );
        const stockOutInDays = avgDailyDemand > 0 ? Math.floor(stock / avgDailyDemand) : null;
        return {
          productId,
          name: product?.name || product?.productName || 'Product',
          soldUnits,
          avgDailyDemand: Number(avgDailyDemand.toFixed(2)),
          forecast7d,
          forecast30d,
          currentStock: stock,
          stockOutInDays,
        };
      })
      .sort((a, b) => b.forecast7d - a.forecast7d)
      .slice(0, 20);

    const recent7Start = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const previous7Start = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
    const recent7 = allOrders.filter((order) =>
      this.isWithinRange(order?.createdAt, recent7Start, new Date()),
    );
    const previous7 = allOrders.filter((order) =>
      this.isWithinRange(order?.createdAt, previous7Start, recent7Start),
    );
    const summarizeDemand = (items: any[]) => {
      const map: Record<string, number> = {};
      items.forEach((order) => {
        (Array.isArray(order?.items) ? order.items : []).forEach((item: any) => {
          const productId = String(item?.id || item?.productId || '');
          if (!productId) return;
          map[productId] =
            (map[productId] || 0) + this.normalizeNumber(item?.quantity, 0);
        });
      });
      return map;
    };
    const recentMap = summarizeDemand(recent7);
    const previousMap = summarizeDemand(previous7);
    const demandSpikes = Object.keys(recentMap)
      .map((productId) => {
        const recentQty = this.normalizeNumber(recentMap[productId], 0);
        const previousQty = this.normalizeNumber(previousMap[productId], 0);
        const ratio =
          previousQty > 0 ? recentQty / previousQty : recentQty > 0 ? 99 : 1;
        return {
          productId,
          name: productNameById.get(productId) || 'Product',
          recentQty,
          previousQty,
          ratio: Number(ratio.toFixed(2)),
        };
      })
      .filter((item) => item.recentQty >= 3 && (item.ratio >= 1.5 || item.previousQty === 0))
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 10);

    const expiringProducts = products
      .map((product: any) => ({
        productId: product?.id,
        name: product?.name || product?.productName || 'Product',
        stock: this.normalizeNumber(
          product?.stock ?? product?.numberInStock ?? product?.quantity,
          0,
        ),
        expiryDate: product?.expiryDate || null,
        daysUntilExpiry: this.daysUntil(product?.expiryDate),
      }))
      .filter((item) => item.daysUntilExpiry !== null)
      .sort((a, b) => this.normalizeNumber(a.daysUntilExpiry, 9999) - this.normalizeNumber(b.daysUntilExpiry, 9999));

    const expiryBuckets = expiringProducts.reduce(
      (acc, item) => {
        const days = this.normalizeNumber(item.daysUntilExpiry, 9999);
        if (days < 0) acc.expired += 1;
        else if (days <= 30) acc.days0to30 += 1;
        else if (days <= 60) acc.days31to60 += 1;
        else if (days <= 90) acc.days61to90 += 1;
        else acc.after90 += 1;
        return acc;
      },
      { expired: 0, days0to30: 0, days31to60: 0, days61to90: 0, after90: 0 },
    );

    const clearanceSuggestions = expiringProducts
      .filter((item) => this.normalizeNumber(item.daysUntilExpiry, 9999) >= 0 && this.normalizeNumber(item.daysUntilExpiry, 9999) <= 30 && item.stock > 0)
      .map((item) => ({
        ...item,
        suggestedDiscountPercent: item.daysUntilExpiry <= 7 ? 35 : item.daysUntilExpiry <= 15 ? 25 : 15,
      }))
      .slice(0, 20);

    const completedOrderItems = orderItems.filter((item) =>
      completedStatuses.has(String(item?.status || '')),
    );
    const profitByCategoryMap: Record<string, { revenue: number; cost: number; profit: number }> = {};
    let totalRevenue = 0;
    let totalCost = 0;

    completedOrderItems.forEach((item) => {
      const product = products.find((p: any) => String(p.id) === String(item.productId));
      const quantity = this.normalizeNumber(item.quantity, 0);
      const unitPrice = this.normalizeNumber(item?.price, this.normalizeNumber(product?.price, 0));
      const estimatedUnitCost = this.normalizeNumber(
        product?.costPrice ?? product?.buyingPrice ?? product?.wholesalePrice,
        unitPrice * 0.7,
      );
      const revenue = unitPrice * quantity;
      const cost = estimatedUnitCost * quantity;
      const category = String(product?.category || 'Uncategorized');

      totalRevenue += revenue;
      totalCost += cost;
      if (!profitByCategoryMap[category]) {
        profitByCategoryMap[category] = { revenue: 0, cost: 0, profit: 0 };
      }
      profitByCategoryMap[category].revenue += revenue;
      profitByCategoryMap[category].cost += cost;
      profitByCategoryMap[category].profit += revenue - cost;
    });

    const grossProfit = totalRevenue - totalCost;
    const grossMarginPct = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const profitByCategory = Object.entries(profitByCategoryMap)
      .map(([category, values]) => ({ category, ...values }))
      .sort((a, b) => this.normalizeNumber(b.profit, 0) - this.normalizeNumber(a.profit, 0));

    const prescriptionOrders = orders.filter((order) => Boolean(order?.requiresPrescription));
    const prescriptionQueue = {
      total: prescriptionOrders.length,
      awaitingUpload: prescriptionOrders.filter((order) => !order?.prescriptionId && pendingStatuses.has(normalizeStatus(order?.status))).length,
      pendingReview: prescriptionOrders.filter((order) => order?.prescriptionId && pendingStatuses.has(normalizeStatus(order?.status))).length,
      approvedOrCompleted: prescriptionOrders.filter((order) => order?.prescriptionId && completedStatuses.has(normalizeStatus(order?.status))).length,
      items: prescriptionOrders.slice(0, 25).map((order) => ({
        orderId: order?.id,
        status: normalizeStatus(order?.status),
        patientId: order?.patientId || order?.buyerId || null,
        total: this.normalizeNumber(order?.total, 0),
        hasPrescription: Boolean(order?.prescriptionId),
        createdAt: order?.createdAt,
      })),
    };

    const outOfStockProducts = products.filter(
      (product: any) =>
        this.normalizeNumber(product?.stock ?? product?.numberInStock ?? product?.quantity, 0) <= 0,
    );
    const substitutionSuggestions = outOfStockProducts
      .map((product: any) => {
        const category = String(product?.category || '').toLowerCase();
        const alternatives = products
          .filter((candidate: any) => {
            if (String(candidate?.id) === String(product?.id)) return false;
            const stock = this.normalizeNumber(
              candidate?.stock ?? candidate?.numberInStock ?? candidate?.quantity,
              0,
            );
            if (stock <= 0) return false;
            const candidateCategory = String(candidate?.category || '').toLowerCase();
            return category ? candidateCategory === category : true;
          })
          .sort((a: any, b: any) => {
            const diffA = Math.abs(
              this.normalizeNumber(a?.price, 0) - this.normalizeNumber(product?.price, 0),
            );
            const diffB = Math.abs(
              this.normalizeNumber(b?.price, 0) - this.normalizeNumber(product?.price, 0),
            );
            return diffA - diffB;
          })
          .slice(0, 3)
          .map((candidate: any) => ({
            productId: candidate?.id,
            name: candidate?.name || candidate?.productName || 'Alternative',
            stock: this.normalizeNumber(
              candidate?.stock ?? candidate?.numberInStock ?? candidate?.quantity,
              0,
            ),
            price: this.normalizeNumber(candidate?.price, 0),
          }));
        return {
          productId: product?.id,
          name: product?.name || product?.productName || 'Product',
          category: product?.category || 'General',
          alternatives,
        };
      })
      .filter((item) => item.alternatives.length > 0)
      .slice(0, 20);

    const events = (InMemoryStore.list('pharmacyEvents') as any[]).filter((event) =>
      String(event?.pharmacyId || '') === String(pharmacyId) &&
      this.isWithinRange(event?.createdAt, range.start, range.end),
    );
    const eventCount = (type: string) =>
      events.filter((event) => String(event?.type || '').toUpperCase() === type).length;
    const funnelViews = eventCount('PRODUCT_VIEW');
    const funnelCartAdds = eventCount('CART_ADD');
    const funnelCheckoutStart = eventCount('CHECKOUT_START');
    const fallbackVisits = orders.length * 3 + Math.max(1, new Set(orders.map((order) => order?.buyerId || order?.patientId).filter(Boolean)).size);
    const funnel = {
      productViews: funnelViews || fallbackVisits,
      cartAdds: funnelCartAdds || Math.max(orderStats.totalOrders, 0),
      checkoutStarted: funnelCheckoutStart || Math.max(orderStats.totalOrders, 0),
      checkoutCompleted: orderStats.completedOrders,
    };
    const abandonmentRate =
      funnel.checkoutStarted > 0
        ? Number((((funnel.checkoutStarted - funnel.checkoutCompleted) / funnel.checkoutStarted) * 100).toFixed(1))
        : 0;

    const customerSummaryMap: Record<string, { orders: number; spend: number }> = {};
    orders.forEach((order) => {
      const customerId = String(order?.buyerId || order?.patientId || '');
      if (!customerId) return;
      if (!customerSummaryMap[customerId]) {
        customerSummaryMap[customerId] = { orders: 0, spend: 0 };
      }
      customerSummaryMap[customerId].orders += 1;
      if (completedStatuses.has(normalizeStatus(order?.status))) {
        customerSummaryMap[customerId].spend += this.normalizeNumber(order?.total, 0);
      }
    });

    const customerIds = Object.keys(customerSummaryMap);
    const customerUsers = customerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: customerIds } },
          select: { id: true, fullName: true, email: true, phone: true },
        })
      : [];
    const customerNameMap = new Map(
      customerUsers.map((user: any) => [user.id, user.fullName || user.email || user.phone || user.id]),
    );
    const topCustomers = customerIds
      .map((customerId) => ({
        customerId,
        name: customerNameMap.get(customerId) || customerId,
        orders: customerSummaryMap[customerId]?.orders || 0,
        spend: customerSummaryMap[customerId]?.spend || 0,
      }))
      .sort((a, b) => this.normalizeNumber(b.spend, 0) - this.normalizeNumber(a.spend, 0))
      .slice(0, 10);
    const uniqueCustomers = customerIds.length;
    const repeatCustomers = Object.values(customerSummaryMap).filter((item) => item.orders > 1).length;
    const avgBasket = orderStats.totalOrders > 0 ? orderStats.moneyFromSales / orderStats.totalOrders : 0;

    const scopedOrderIds = new Set(
      orders.map((order) => String(order?.id || '')).filter(Boolean),
    );
    const payments = (InMemoryStore.list('payments') as any[]).filter(
      (payment) =>
        scopedOrderIds.has(String(payment?.orderId || '')) &&
        this.isWithinRange(payment?.createdAt, range.start, range.end),
    );
    const failedPayments = payments.filter(
      (payment) => String(payment?.status || '').toUpperCase() === 'FAILED',
    );
    const walletPayments = (InMemoryStore.list('payments') as any[]).filter((payment) => {
      const recipientId = String(payment?.recipientId || '');
      if (!recipientId) return false;
      if (!scope.orderOwnerIds.includes(recipientId)) return false;
      return this.isWithinRange(payment?.createdAt, range.start, range.end);
    });
    const walletPaidPayments = walletPayments.filter(
      (payment) => String(payment?.status || '').toUpperCase() === 'PAID',
    );
    const walletPendingPayments = walletPayments.filter((payment) =>
      pendingStatuses.has(String(payment?.status || '').toUpperCase()),
    );
    const walletFailedPayments = walletPayments.filter((payment) =>
      cancelledStatuses.has(String(payment?.status || '').toUpperCase()) ||
      String(payment?.status || '').toUpperCase() === 'FAILED',
    );
    const walletAvailable = walletPaidPayments.reduce(
      (sum: number, payment: any) => sum + this.normalizeNumber(payment?.amount, 0),
      0,
    );
    const walletPending = walletPendingPayments.reduce(
      (sum: number, payment: any) => sum + this.normalizeNumber(payment?.amount, 0),
      0,
    );
    const averageOrderValue =
      orderStats.totalOrders > 0 ? orderStats.moneyFromSales / orderStats.totalOrders : 0;
    const highValueOrders = orders.filter(
      (order) => this.normalizeNumber(order?.total, 0) > averageOrderValue * 3 && averageOrderValue > 0,
    );

    const rapidRepeatSignals: any[] = [];
    const byBuyer = new Map<string, any[]>();
    orders.forEach((order) => {
      const buyerId = String(order?.buyerId || order?.patientId || '');
      if (!buyerId) return;
      if (!byBuyer.has(buyerId)) byBuyer.set(buyerId, []);
      byBuyer.get(buyerId)?.push(order);
    });
    byBuyer.forEach((buyerOrders, buyerId) => {
      const sorted = [...buyerOrders].sort(
        (a, b) =>
          new Date(a?.createdAt || 0).getTime() - new Date(b?.createdAt || 0).getTime(),
      );
      let streak = 1;
      for (let i = 1; i < sorted.length; i += 1) {
        const previous = new Date(sorted[i - 1]?.createdAt || 0).getTime();
        const current = new Date(sorted[i]?.createdAt || 0).getTime();
        const gapMinutes = (current - previous) / (60 * 1000);
        if (gapMinutes <= 10) streak += 1;
        else streak = 1;
        if (streak >= 3) {
          rapidRepeatSignals.push({
            buyerId,
            buyerName: customerNameMap.get(buyerId) || buyerId,
            streak,
            latestOrderId: sorted[i]?.id,
          });
          break;
        }
      }
    });

    const completedOrders = orders.filter((order) => completedStatuses.has(normalizeStatus(order?.status)));
    const completionTimes = completedOrders
      .map((order) => {
        const created = new Date(order?.createdAt || 0).getTime();
        const completedAt = new Date(order?.completedAt || order?.updatedAt || order?.createdAt || 0).getTime();
        const diff = (completedAt - created) / (60 * 1000);
        return Number.isFinite(diff) && diff >= 0 ? diff : null;
      })
      .filter((value): value is number => value !== null);
    const avgFulfillmentMins =
      completionTimes.length > 0
        ? completionTimes.reduce((sum, value) => sum + value, 0) / completionTimes.length
        : 0;
    const pendingOverSla = orders.filter((order) => {
      const status = normalizeStatus(order?.status);
      if (!pendingStatuses.has(status)) return false;
      const created = new Date(order?.createdAt || 0).getTime();
      const elapsed = (Date.now() - created) / (60 * 1000);
      return elapsed > 120;
    }).length;
    const onTimeRate =
      completionTimes.length > 0
        ? Number(
            ((completionTimes.filter((minutes) => minutes <= 120).length / completionTimes.length) * 100).toFixed(1),
          )
        : 0;

    const role = String(req.user?.role || '').toUpperCase();
    let branchTenants: any[] = [];
    if (role === 'SUPER_ADMIN') {
      branchTenants = await this.prisma.tenant.findMany({
        where: { type: 'PHARMACY' },
        include: { users: true },
      });
    } else {
      const currentTenant = await this.prisma.tenant.findUnique({
        where: { id: pharmacyId },
        include: { users: true },
      });
      if (currentTenant) branchTenants = [currentTenant];
    }

    const branchUserIds = branchTenants
      .map((tenant) => {
        const primary = tenant?.users?.find((u: any) => u.isPrimary) || tenant?.users?.[0];
        return primary?.userId || null;
      })
      .filter(Boolean);
    const branchExtrasMap = branchUserIds.length
      ? await getProfileExtrasMap(this.prisma, branchUserIds as string[])
      : new Map<string, any>();
    const branchProductRows =
      role === 'SUPER_ADMIN' && branchTenants.length
        ? await this.db.product.findMany({
            where: { pharmacyId: { in: branchTenants.map((tenant) => tenant.id) } },
            select: { pharmacyId: true, id: true },
          })
        : products.map((product: any) => ({
            pharmacyId: product?.pharmacyId || pharmacyId,
            id: product?.id,
          }));
    const branchProductCounts = branchProductRows.reduce((acc: Record<string, number>, product: any) => {
      const key = String(product?.pharmacyId || '');
      if (!key) return acc;
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {});

    const branchSummary = branchTenants.map((tenant) => {
      const branchOrders = (InMemoryStore.list('orders') as any[]).filter(
        (order) => String(order?.pharmacyId || '') === String(tenant.id),
      );
      const primary = tenant?.users?.find((u: any) => u.isPrimary) || tenant?.users?.[0];
      const extras = primary?.userId ? branchExtrasMap.get(primary.userId) || {} : {};
      const sales = branchOrders
        .filter((order) => completedStatuses.has(normalizeStatus(order?.status)))
        .reduce((sum, order) => sum + this.normalizeNumber(order?.total, 0), 0);
      return {
        tenantId: tenant.id,
        branchName: extras?.pharmacyName || tenant.name || 'Branch',
        orderCount: branchOrders.length,
        productCount: this.normalizeNumber(branchProductCounts[String(tenant.id)], 0),
        sales,
      };
    });

    const lowStockProducts = autoReorder.filter((item) => item.stock <= item.reorderLevel);
    const smartAlertItems = this.buildSmartAlertItems({
      pharmacyId,
      lowStockProducts,
      expiringProducts: clearanceSuggestions,
      demandSpikes,
      failedPayments,
    });

    return {
      pharmacyId,
      totals: {
        ...orderStats,
        ...productStats,
        soldProducts,
      },
      charts: {
        orderStatus: [
          { label: 'Completed', value: orderStats.completedOrders },
          { label: 'Pending', value: orderStats.pendingOrders },
          { label: 'Cancelled', value: orderStats.cancelledOrders },
        ],
        productStock: [
          { label: 'In Stock', value: Math.max(productStats.totalProducts - productStats.outOfStock, 0) },
          { label: 'Low Stock', value: productStats.lowStock },
          { label: 'Out of Stock', value: productStats.outOfStock },
        ],
        profitSplit: [
          { label: 'Revenue', value: Number(totalRevenue.toFixed(2)) },
          { label: 'Cost', value: Number(totalCost.toFixed(2)) },
          { label: 'Gross Profit', value: Number(grossProfit.toFixed(2)) },
        ],
        funnel: [
          { label: 'Views', value: funnel.productViews },
          { label: 'Cart Adds', value: funnel.cartAdds },
          { label: 'Checkout Started', value: funnel.checkoutStarted },
          { label: 'Checkout Completed', value: funnel.checkoutCompleted },
        ],
      },
      topSoldProducts,
      demandForecast,
      demandSpikes,
      autoReorder: {
        suggestions: autoReorder,
        totalSuggestedItems: autoReorder.length,
        totalEstimatedCost: autoReorder.reduce(
          (sum, item) => sum + this.normalizeNumber(item.unitPrice, 0) * this.normalizeNumber(item.recommendedQty, 0),
          0,
        ),
      },
      expiryManagement: {
        buckets: expiryBuckets,
        expiringProducts: expiringProducts.slice(0, 30),
        clearanceSuggestions,
        fefoPriority: expiringProducts.filter((item) => item.stock > 0).slice(0, 30),
      },
      profitAnalytics: {
        totals: {
          revenue: Number(totalRevenue.toFixed(2)),
          cost: Number(totalCost.toFixed(2)),
          grossProfit: Number(grossProfit.toFixed(2)),
          grossMarginPct: Number(grossMarginPct.toFixed(2)),
        },
        byCategory: profitByCategory,
      },
      prescriptionQueue,
      substitutionEngine: {
        outOfStockCount: outOfStockProducts.length,
        suggestions: substitutionSuggestions,
      },
      conversionFunnel: {
        ...funnel,
        abandonmentRate,
      },
      customerInsights: {
        uniqueCustomers,
        repeatCustomers,
        retentionRate: uniqueCustomers > 0 ? Number(((repeatCustomers / uniqueCustomers) * 100).toFixed(1)) : 0,
        averageBasketValue: Number(avgBasket.toFixed(2)),
        topCustomers,
      },
      riskChecks: {
        failedPayments: failedPayments.length,
        highValueOrders: highValueOrders.map((order) => ({
          orderId: order?.id,
          customerId: order?.buyerId || order?.patientId || null,
          amount: this.normalizeNumber(order?.total, 0),
          createdAt: order?.createdAt,
        })),
        rapidRepeatSignals,
      },
      slaDashboard: {
        avgFulfillmentMins: Number(avgFulfillmentMins.toFixed(1)),
        pendingOverSla,
        onTimeRate,
        completedOrders: completedOrders.length,
      },
      multiBranch: {
        branches: branchSummary,
      },
      smartNotifications: {
        preview: smartAlertItems,
        counts: {
          lowStock: lowStockProducts.length,
          expiringSoon: clearanceSuggestions.length,
          demandSpikes: demandSpikes.length,
          failedPayments: failedPayments.length,
        },
      },
      wallet: {
        currency: 'KES',
        availableBalance: Number(walletAvailable.toFixed(2)),
        pendingBalance: Number(walletPending.toFixed(2)),
        totalReceived: Number(walletAvailable.toFixed(2)),
        totalTransactions: walletPayments.length,
        paidTransactions: walletPaidPayments.length,
        pendingTransactions: walletPendingPayments.length,
        failedTransactions: walletFailedPayments.length,
      },
      currency: 'KES',
      filters: {
        startDate: range.start ? range.start.toISOString() : null,
        endDate: range.end ? range.end.toISOString() : null,
        preset: preset || null,
      },
      generatedAt: new Date().toISOString(),
    };
  }

  @Post(':id/products')
  async createProduct(@Req() req: any, @Param('id') pharmacyId: string, @Body() body: any) {
    const role = String(req.user?.role || '').toUpperCase();
    const access = await this.assertInventoryAccess(req.user?.userId, pharmacyId, role);
    if (role !== 'SUPER_ADMIN') {
      await this.ensureInventoryProfileComplete(
        req.user?.userId,
        String(access?.tenant?.type || 'PHARMACY') as 'PHARMACY' | 'HOSPITAL',
      );
    }
    const payload = this.normalizeProductPayload(body, pharmacyId);
    const created = await this.db.product.create({
      data: payload,
    });
    await this.logStockMovement({
      pharmacyId,
      productId: created.id,
      productName: created.name || created.productName,
      type: 'CREATED',
      quantityChange: created.quantity || 0,
      stockBefore: 0,
      stockAfter: created.stock ?? created.numberInStock ?? created.quantity ?? 0,
      reason: 'Initial product creation',
      actorId: req.user?.userId,
    });
    this.createAlertNotifications({
      userId: req.user?.userId,
      product: created,
      previousStock: null,
    });
    return created;
  }

  @Put(':id/products/:productId')
  async updateProduct(
    @Req() req: any,
    @Param('id') pharmacyId: string,
    @Param('productId') productId: string,
    @Body() body: any,
  ) {
    const role = String(req.user?.role || '').toUpperCase();
    const access = await this.assertInventoryAccess(req.user?.userId, pharmacyId, role);
    if (role !== 'SUPER_ADMIN') {
      await this.ensureInventoryProfileComplete(
        req.user?.userId,
        String(access?.tenant?.type || 'PHARMACY') as 'PHARMACY' | 'HOSPITAL',
      );
    }
    const previous = await this.db.product.findFirst({
      where: { id: productId, pharmacyId },
    });
    if (!previous) return null;
    const payload = this.normalizeProductPayload(body, pharmacyId);
    const hasIncomingImage =
      typeof body?.imageUrl === 'string' ||
      typeof body?.image === 'string' ||
      typeof body?.photoUrl === 'string';
    if (!hasIncomingImage) {
      delete payload.imageUrl;
    }
    const updated = await this.db.product.update({
      where: { id: productId },
      data: payload,
    });

    const previousStock = this.normalizeNumber(
      previous?.stock ?? previous?.numberInStock ?? previous?.quantity,
      0,
    );
    const updatedStock = this.normalizeNumber(
      updated.stock ?? updated.numberInStock ?? updated.quantity,
      0,
    );
    const delta = updatedStock - previousStock;
    if (delta !== 0) {
      await this.logStockMovement({
        pharmacyId,
        productId: updated.id,
        productName: updated.name || updated.productName,
        type: delta > 0 ? 'RESTOCK' : 'SALE',
        quantityChange: delta,
        stockBefore: previousStock,
        stockAfter: updatedStock,
        reason: body?.reason || (delta > 0 ? 'Stock increased' : 'Stock reduced'),
        actorId: req.user?.userId,
      });
    } else {
      await this.logStockMovement({
        pharmacyId,
        productId: updated.id,
        productName: updated.name || updated.productName,
        type: 'UPDATED',
        quantityChange: 0,
        stockBefore: previousStock,
        stockAfter: updatedStock,
        reason: body?.reason || 'Product details updated',
        actorId: req.user?.userId,
      });
    }

    this.createAlertNotifications({
      userId: req.user?.userId,
      product: updated,
      previousStock,
    });

    return updated;
  }

  @Delete(':id/products/:productId')
  async deleteProduct(@Req() req: any, @Param('id') pharmacyId: string, @Param('productId') productId: string) {
    const role = String(req.user?.role || '').toUpperCase();
    const access = await this.assertInventoryAccess(req.user?.userId, pharmacyId, role);
    if (role !== 'SUPER_ADMIN') {
      await this.ensureInventoryProfileComplete(
        req.user?.userId,
        String(access?.tenant?.type || 'PHARMACY') as 'PHARMACY' | 'HOSPITAL',
      );
    }
    const existing = await this.db.product.findFirst({
      where: { id: productId, pharmacyId },
    });
    if (!existing) return { success: false };

    await this.db.product.delete({
      where: { id: productId },
    });
    await this.logStockMovement({
        pharmacyId: existing.pharmacyId,
        productId: existing.id,
        productName: existing.name || existing.productName,
        type: 'DELETED',
        quantityChange: 0,
        stockBefore: existing.stock ?? existing.numberInStock ?? existing.quantity ?? 0,
        stockAfter: 0,
        reason: 'Product deleted',
        actorId: req.user?.userId,
      });
    return { success: true };
  }
}
