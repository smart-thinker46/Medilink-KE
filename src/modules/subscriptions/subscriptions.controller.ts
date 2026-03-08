import { Controller, Post, Body, UseGuards, Req, Put, Param, Get, BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { PrismaService } from 'src/database/prisma.service';
import { mergeProfileExtras } from 'src/common/profile-extras';
import { getSubscriptionPricingPersistent } from 'src/common/subscription-pricing';

@Controller('subscriptions')
@UseGuards(AuthGuard('jwt'))
export class SubscriptionsController {
  constructor(private prisma: PrismaService) {}

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const paymentId = String(body?.paymentId || body?.payment_id || '').trim();
    if (!paymentId) {
      throw new BadRequestException('paymentId is required to activate subscription');
    }
    const payment = InMemoryStore.findById('payments', paymentId) as any;
    if (!payment) {
      throw new BadRequestException('Payment not found');
    }
    if (payment.userId !== req.user?.userId) {
      throw new ForbiddenException('You cannot activate subscription with this payment');
    }
    if (String(payment.status || '').toUpperCase() !== 'PAID') {
      throw new BadRequestException('Payment is not completed');
    }
    if (String(payment.type || '').toUpperCase() !== 'SUBSCRIPTION') {
      throw new BadRequestException('Payment type is not subscription');
    }
    if (payment.subscriptionActivatedAt) {
      throw new BadRequestException('This payment has already been used');
    }

    const record = InMemoryStore.create('subscriptions', {
      userId: req.user?.userId,
      role: req.user?.role,
      plan: body.plan || payment.plan || 'monthly',
      amount: Number(body.amount || payment.amount || 0),
      currency: body.currency || payment.currency || 'KES',
      status: 'ACTIVE',
      startedAt: new Date().toISOString(),
      paymentId,
    });
    InMemoryStore.update('payments', paymentId, {
      subscriptionActivatedAt: new Date().toISOString(),
      subscriptionId: record.id,
    });
    await mergeProfileExtras(this.prisma, req.user?.userId, {
      subscriptionActive: true,
      premiumActive: true,
      aiEnabled: false,
    });
    return record;
  }

  @Put(':id/cancel')
  async cancel(@Param('id') id: string) {
    const updated = InMemoryStore.update('subscriptions', id, {
      status: 'CANCELED',
      canceledAt: new Date().toISOString(),
    });
    const userId = updated?.userId;
    if (userId) {
      await mergeProfileExtras(this.prisma, userId, {
        subscriptionActive: false,
        premiumActive: false,
        aiEnabled: false,
      });
    }
    return updated;
  }

  @Get('my')
  async listMine(@Req() req: any) {
    return InMemoryStore.list('subscriptions').filter((s: any) => s.userId === req.user?.userId);
  }

  @Get('pricing')
  async pricing() {
    return getSubscriptionPricingPersistent(this.prisma);
  }
}
