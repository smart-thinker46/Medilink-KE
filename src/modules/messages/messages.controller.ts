import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  Req,
  BadRequestException,
  Put,
  Delete,
  Param,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from 'src/database/prisma.service';
import { MessagesGateway } from './messages.gateway';
import { InMemoryStore } from 'src/common/in-memory.store';
import { getProfileExtrasMap } from 'src/common/profile-extras';
import { assertCanCommunicate } from 'src/common/communication-rules';
import { UserRole } from '@prisma/client';
import { NotificationsGateway } from '../notifications/notifications.gateway';

@Controller('messages')
@UseGuards(AuthGuard('jwt'))
export class MessagesController {
  constructor(
    private prisma: PrismaService,
    private messagesGateway: MessagesGateway,
    private notificationsGateway: NotificationsGateway,
  ) {}

  @Get('thread')
  async thread(@Req() req: any, @Query('userId') userId: string) {
    const currentUserId = req.user?.userId;
    if (!currentUserId || !userId) return [];
    const pendingDelivery = await this.prisma.message.findMany({
      where: {
        senderId: userId,
        recipientId: currentUserId,
        deliveredAt: null,
        hiddenForRecipient: false,
      } as any,
      select: { id: true },
    });
    if (pendingDelivery.length > 0) {
      const deliveredAt = new Date();
      await this.prisma.message.updateMany({
        where: {
          id: { in: pendingDelivery.map((item) => item.id) },
        },
        data: {
          deliveredAt,
        } as any,
      });
      pendingDelivery.forEach((item) => {
        this.messagesGateway.emitDeliveredReceipt(userId, {
          messageId: item.id,
          deliveredAt,
        });
      });
    }

    return this.prisma.message.findMany({
      where: {
        OR: [
          {
            senderId: currentUserId,
            recipientId: userId,
            hiddenForSender: false,
          } as any,
          {
            senderId: userId,
            recipientId: currentUserId,
            hiddenForRecipient: false,
          } as any,
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  @Get('conversations')
  async conversations(@Req() req: any) {
    const currentUserId = req.user?.userId;
    if (!currentUserId) return [];

    const messages = await this.prisma.message.findMany({
      where: {
        OR: [
          {
            senderId: currentUserId,
            hiddenForSender: false,
          } as any,
          {
            recipientId: currentUserId,
            hiddenForRecipient: false,
          } as any,
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    const seen = new Set<string>();
    const conversationUsers: string[] = [];

    messages.forEach((message) => {
      const otherId =
        message.senderId === currentUserId ? message.recipientId : message.senderId;
      if (!seen.has(otherId)) {
        seen.add(otherId);
        conversationUsers.push(otherId);
      }
    });

    if (conversationUsers.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: conversationUsers } },
      select: { id: true, fullName: true, email: true, role: true, lastLogin: true },
    });
    const userMap = new Map(users.map((user) => [user.id, user]));
    const extrasMap = await getProfileExtrasMap(this.prisma, users.map((u) => u.id));

    const unreadCounts = await this.prisma.message.groupBy({
      by: ['senderId'],
      where: {
        recipientId: currentUserId,
        readAt: null,
        senderId: { in: conversationUsers },
        hiddenForRecipient: false,
      } as any,
      _count: { _all: true },
    });
    const unreadMap = new Map(
      (unreadCounts as any[]).map((item) => [item.senderId, item._count?._all || 0]),
    );

    return conversationUsers.map((userId) => {
      const lastMessage = messages.find((message) => {
        const otherId =
          message.senderId === currentUserId ? message.recipientId : message.senderId;
        return otherId === userId;
      });
      const lastSeenByUser = messages.find(
        (message) =>
          message.senderId === currentUserId &&
          message.recipientId === userId &&
          (message as any).readAt,
      );
      const user = userMap.get(userId);
      const extras = user ? extrasMap.get(user.id) || {} : {};
      return {
        user: {
          ...user,
          avatarUrl: extras.profilePhoto || extras.avatarUrl || null,
        },
        lastMessage,
        unreadCount: unreadMap.get(userId) || 0,
        lastSeenAt: (lastSeenByUser as any)?.readAt || null,
      };
    });
  }

  @Post('send')
  async send(@Req() req: any, @Body() body: any) {
    const senderId = req.user?.userId;
    const recipientId = body.recipientId;
    if (!senderId || !recipientId) {
      throw new BadRequestException('recipientId is required');
    }
    const senderRole = req.user?.role as UserRole;
    const recipient = await this.prisma.user.findUnique({
      where: { id: recipientId },
      select: { id: true, role: true },
    });
    if (!recipient) {
      throw new BadRequestException('recipientId is invalid');
    }
    assertCanCommunicate(senderRole, recipient.role, 'Chat');
    const message = await this.prisma.message.create({
      data: {
        senderId,
        recipientId,
        text: body.text || '',
        channel: body.channel || 'chat',
      },
    });
    let updated = message;
    if (this.messagesGateway.isUserOnline(recipientId)) {
      updated = await this.prisma.message.update({
        where: { id: message.id },
        data: { deliveredAt: new Date() } as any,
      });
      this.messagesGateway.emitDeliveredReceipt(senderId, {
        messageId: updated.id,
        deliveredAt: (updated as any).deliveredAt,
      });
    }
    this.messagesGateway.emitToUsers([senderId, recipientId], updated);

    const notification = InMemoryStore.create('notifications', {
      userId: recipientId,
      title: 'New message',
      message: body.text ? String(body.text).slice(0, 160) : 'You have a new message.',
      type: 'CHAT',
      relatedId: updated.id,
      isRead: false,
      createdAt: new Date().toISOString(),
    });
    this.notificationsGateway.emitToUser(recipientId, {
      title: notification.title,
      message: notification.message,
    });
    return updated;
  }

  @Put('read')
  async markRead(@Req() req: any, @Body() body: any) {
    const currentUserId = req.user?.userId;
    const otherUserId = body.userId;
    if (!currentUserId || !otherUserId) {
      throw new BadRequestException('userId is required');
    }
    await this.prisma.message.updateMany({
      where: {
        senderId: otherUserId,
        recipientId: currentUserId,
        readAt: null,
        hiddenForRecipient: false,
      } as any,
      data: {
        readAt: new Date(),
      } as any,
    });
    this.messagesGateway.emitReadReceipt(otherUserId, {
      readerId: currentUserId,
    });
    return { success: true };
  }

  @Delete(':id')
  async deleteForMe(@Req() req: any, @Param('id') id: string) {
    const currentUserId = req.user?.userId;
    if (!currentUserId || !id) {
      throw new BadRequestException('message id is required');
    }

    const message = await this.prisma.message.findUnique({
      where: { id },
      select: { id: true, senderId: true, recipientId: true },
    });

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    if (message.senderId !== currentUserId && message.recipientId !== currentUserId) {
      throw new ForbiddenException('Not allowed to delete this message');
    }

    const data =
      message.senderId === currentUserId
        ? { hiddenForSender: true }
        : { hiddenForRecipient: true };

    await this.prisma.message.update({
      where: { id },
      data: data as any,
    });

    return { success: true };
  }

  @Delete(':id/everyone')
  async deleteForEveryone(@Req() req: any, @Param('id') id: string) {
    const currentUserId = req.user?.userId;
    if (!currentUserId || !id) {
      throw new BadRequestException('message id is required');
    }

    const message = (await this.prisma.message.findUnique({
      where: { id },
    } as any)) as any;

    if (!message) {
      throw new NotFoundException('Message not found');
    }

    if (message.senderId !== currentUserId) {
      throw new ForbiddenException('Only sender can delete for everyone');
    }

    try {
      await this.prisma.message.update({
        where: { id },
        data: {
          deletedForEveryone: true,
          deletedAt: new Date(),
          hiddenForSender: true,
          hiddenForRecipient: true,
        } as any,
      });
    } catch {
      // Backward compatibility: if deletedForEveryone/deletedAt columns are not migrated yet,
      // still enforce delete-for-everyone by hiding message for both participants.
      await this.prisma.message.update({
        where: { id },
        data: {
          hiddenForSender: true,
          hiddenForRecipient: true,
        } as any,
      });
    }

    const payload = {
      messageId: message.id,
      senderId: message.senderId,
      recipientId: message.recipientId,
    };
    this.messagesGateway.emitDeleted(message.senderId, payload);
    this.messagesGateway.emitDeleted(message.recipientId, payload);

    return { success: true };
  }
}
