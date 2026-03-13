import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  UseGuards,
  Req,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { NotificationsGateway } from './notifications.gateway';
import { PushService } from 'src/common/push.service';
import { getProfileExtras, mergeProfileExtras } from 'src/common/profile-extras';
import { PrismaService } from 'src/database/prisma.service';

@Controller('notifications')
@UseGuards(AuthGuard('jwt'))
export class NotificationsController {
  constructor(
    private notificationsGateway: NotificationsGateway,
    private push: PushService,
    private prisma: PrismaService,
  ) {}

  @Get()
  async list(@Req() req: any) {
    const userId = req.user.userId;
    return InMemoryStore.list('notifications').filter((n) => n.userId === userId);
  }

  @Post()
  async create(@Body() body: any) {
    const record = InMemoryStore.create('notifications', {
      userId: body.user_id,
      title: body.title,
      message: body.message,
      type: body.type || 'INFO',
      relatedId: body.related_id,
      data: body.data || null,
      isRead: false,
      createdAt: new Date().toISOString(),
    });
    if (body.user_id) {
      this.notificationsGateway.emitToUser(body.user_id, {
        title: body.title,
        message: body.message,
        type: body.type || 'INFO',
        data: body.data || null,
      });

      const extras = await getProfileExtras(this.prisma, body.user_id);
      const tokens = Array.isArray(extras.pushTokens) ? extras.pushTokens : [];
      const unreadCount = InMemoryStore.list('notifications').filter(
        (item) => item.userId === body.user_id && !item.isRead,
      ).length;
      if (tokens.length) {
        await this.push.sendToTokens(tokens, {
          title: body.title || 'Notification',
          body: body.message || '',
          data: { ...(body.data || {}), badge: unreadCount },
          badge: unreadCount,
          sound: 'default',
        });
      }
    }
    return record;
  }

  @Post('register-device')
  async registerDevice(@Req() req: any, @Body() body: any) {
    const userId = req.user?.userId;
    const token = String(body?.token || '').trim();
    if (!userId || !token) return { success: false };
    const extras = await getProfileExtras(this.prisma, userId);
    const existing = Array.isArray(extras.pushTokens) ? extras.pushTokens : [];
    const next = Array.from(new Set([...existing, token]));
    await mergeProfileExtras(this.prisma, userId, { pushTokens: next });
    return { success: true, tokens: next };
  }

  @Put(':id/read')
  async markRead(@Param('id') id: string) {
    return InMemoryStore.update('notifications', id, { isRead: true });
  }

  @Post('support-chat/request')
  async requestSupportChat(@Req() req: any, @Body() body: any) {
    const requesterId = req.user?.userId;
    if (!requesterId) {
      throw new BadRequestException('User is required');
    }

    const requester = await this.prisma.user.findUnique({
      where: { id: requesterId },
      select: { id: true, fullName: true, email: true, role: true },
    });
    if (!requester) {
      throw new NotFoundException('Requester not found');
    }

    const admins = await this.prisma.user.findMany({
      where: { role: 'SUPER_ADMIN' },
      select: { id: true, fullName: true, email: true, role: true },
      orderBy: { createdAt: 'asc' },
      take: 10,
    });

    if (!admins.length) {
      throw new BadRequestException('No admin support account is available');
    }

    const pending = InMemoryStore.list('supportChatRequests').find(
      (item: any) => item.requesterId === requesterId && item.status === 'PENDING',
    ) as any;
    if (pending) {
      return {
        success: true,
        requestId: pending.id,
        status: pending.status,
        message: 'Support chat request is already pending.',
      };
    }

    const request = InMemoryStore.create('supportChatRequests', {
      requesterId,
      requesterName: requester.fullName || requester.email || 'User',
      requesterRole: requester.role,
      note: String(body?.note || '').trim(),
      status: 'PENDING',
      requestedAt: new Date().toISOString(),
      handledBy: null,
      handledAt: null,
    } as any);

    admins.forEach((admin) => {
      const title = 'Support chat request';
      const message = `${requester.fullName || requester.email || 'A user'} requested admin chat support.`;
      InMemoryStore.create('notifications', {
        userId: admin.id,
        title,
        message,
        type: 'SUPPORT_CHAT_REQUEST',
        relatedId: request.id,
        data: {
          requestId: request.id,
          requesterId,
          requesterName: requester.fullName || requester.email || 'User',
          requesterRole: requester.role,
          note: String(body?.note || '').trim() || null,
        },
        isRead: false,
        createdAt: new Date().toISOString(),
      });
      this.notificationsGateway.emitToUser(admin.id, {
        title,
        message,
        type: 'SUPPORT_CHAT_REQUEST',
        data: {
          requestId: request.id,
          requesterId,
          requesterName: requester.fullName || requester.email || 'User',
          requesterRole: requester.role,
        },
      });
    });

    return {
      success: true,
      requestId: request.id,
      status: request.status,
    };
  }

  @Post('support-chat/respond')
  async respondSupportChat(@Req() req: any, @Body() body: any) {
    const adminId = req.user?.userId;
    const adminRole = String(req.user?.role || '').toUpperCase();
    if (adminRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only admin can respond to support chat requests');
    }

    const requestId = String(body?.requestId || '').trim();
    const accept = Boolean(body?.accept);
    if (!requestId) {
      throw new BadRequestException('requestId is required');
    }

    const request = InMemoryStore.findById('supportChatRequests', requestId) as any;
    if (!request) {
      throw new NotFoundException('Support chat request not found');
    }

    if (request.status !== 'PENDING') {
      return {
        success: true,
        requestId: request.id,
        status: request.status,
      };
    }

    const admin = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: { id: true, fullName: true, email: true },
    });

    const status = accept ? 'ACCEPTED' : 'REJECTED';
    const updated = InMemoryStore.update('supportChatRequests', request.id, {
      status,
      handledBy: adminId,
      handledAt: new Date().toISOString(),
    } as any) as any;

    const responseTitle = accept ? 'Support chat accepted' : 'Support chat request declined';
    const responseMessage = accept
      ? `${admin?.fullName || admin?.email || 'Admin'} accepted your support chat request.`
      : `${admin?.fullName || admin?.email || 'Admin'} declined your support chat request.`;

    InMemoryStore.create('notifications', {
      userId: request.requesterId,
      title: responseTitle,
      message: responseMessage,
      type: accept ? 'SUPPORT_CHAT_ACCEPTED' : 'SUPPORT_CHAT_REJECTED',
      relatedId: request.id,
      data: {
        requestId: request.id,
        adminId: admin?.id || adminId,
        adminName: admin?.fullName || admin?.email || 'Admin',
        requesterId: request.requesterId,
      },
      isRead: false,
      createdAt: new Date().toISOString(),
    });
    this.notificationsGateway.emitToUser(request.requesterId, {
      title: responseTitle,
      message: responseMessage,
      type: accept ? 'SUPPORT_CHAT_ACCEPTED' : 'SUPPORT_CHAT_REJECTED',
      data: {
        requestId: request.id,
        adminId: admin?.id || adminId,
        adminName: admin?.fullName || admin?.email || 'Admin',
      },
    });

    return {
      success: true,
      requestId: request.id,
      status: updated?.status || status,
    };
  }
}
