import { Controller, Post, Get, Param, Body, UseGuards, Req, BadRequestException, ForbiddenException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { getProfileExtras } from 'src/common/profile-extras';
import { PrismaService } from 'src/database/prisma.service';
import { assertCanCommunicate } from 'src/common/communication-rules';
import { UserRole } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'crypto';
import { NotificationsGateway } from '../notifications/notifications.gateway';

@Controller('video-calls')
@UseGuards(AuthGuard('jwt'))
export class VideoCallsController {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private notificationsGateway: NotificationsGateway,
  ) {}

  private async resolveParticipantUserId(participantId?: string) {
    if (!participantId) return null;

    const directUser = await this.prisma.user.findUnique({
      where: { id: participantId },
      select: { id: true },
    });
    if (directUser?.id) {
      return directUser.id;
    }

    const medic = await this.prisma.medic.findUnique({
      where: { id: participantId },
      select: { userId: true },
    });
    if (medic?.userId) {
      return medic.userId;
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: participantId },
      include: {
        users: {
          include: {
            user: {
              select: { id: true },
            },
          },
        },
      },
    });

    if (!tenant) return null;

    const primaryLink =
      tenant.users?.find((link) => link.isPrimary) || tenant.users?.[0];
    return primaryLink?.user?.id || null;
  }

  private async assertAllowed(req: any, recipientId?: string) {
    if (!recipientId) return undefined;
    const senderRole = req.user?.role as UserRole;
    const resolvedRecipientId =
      (await this.resolveParticipantUserId(recipientId)) || recipientId;

    const recipient = await this.prisma.user.findUnique({
      where: { id: resolvedRecipientId },
      select: { id: true, role: true },
    });
    if (!recipient) {
      throw new BadRequestException('participant_id is invalid');
    }
    assertCanCommunicate(senderRole, recipient.role, 'Video call');
    return recipient.id;
  }

  private async getDefaultEmergencyParticipantId() {
    const hospitalUser = await this.prisma.user.findFirst({
      where: { role: 'HOSPITAL_ADMIN' },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    return hospitalUser?.id || null;
  }

  private getStreamApiKey() {
    return (
      this.config.get<string>('STREAM_API_KEY') ||
      this.config.get<string>('EXPO_PUBLIC_STREAM_API_KEY')
    );
  }

  private getStreamApiSecret() {
    return this.config.get<string>('STREAM_API_SECRET');
  }

  private base64UrlEncode(value: string) {
    return Buffer.from(value)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }

  private buildStreamUserToken(userId: string, secret: string, expireSeconds: number) {
    const now = Math.floor(Date.now() / 1000);
    const header = this.base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = this.base64UrlEncode(
      JSON.stringify({
        user_id: userId,
        iat: now,
        exp: now + expireSeconds,
      }),
    );
    const content = `${header}.${payload}`;
    const signature = createHmac('sha256', secret)
      .update(content)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return `${content}.${signature}`;
  }

  @Post()
  async create(@Req() req: any, @Body() body: any) {
    let participantId: string | undefined;
    if (body.call_type === 'emergency') {
      participantId =
        (await this.resolveParticipantUserId(body.participant_id)) || undefined;
      if (!participantId) {
        participantId = (await this.getDefaultEmergencyParticipantId()) || undefined;
      }
      if (participantId) {
        participantId = await this.assertAllowed(req, participantId);
      }
    } else {
      participantId = await this.assertAllowed(req, body.participant_id);
    }
    const callerRole = (req.user?.role || 'PATIENT') as UserRole;
    const extras = await getProfileExtras(this.prisma, req.user?.userId);
    const isPremium =
      callerRole === 'SUPER_ADMIN' ||
      Boolean(extras?.subscriptionActive);
    const paymentId = body.payment_id;
    if (!isPremium && paymentId) {
      const payment = InMemoryStore.findById('payments', paymentId) as any;
      const isValidPaidCallPayment =
        Boolean(payment) &&
        payment.userId === req.user?.userId &&
        String(payment.status || '').toUpperCase() === 'PAID' &&
        String(payment.type || '').toUpperCase() === 'VIDEO_CALL';
      if (!isValidPaidCallPayment) {
        return {
          success: false,
          requiresPayment: true,
          amount: body.amount || 100,
          currency: 'KES',
          minutes: body.minutes || 30,
        };
      }
    }
    if (!isPremium && !paymentId) {
      return {
        success: false,
        requiresPayment: true,
        amount: body.amount || 100,
        currency: 'KES',
        minutes: body.minutes || 30,
      };
    }
    const call = InMemoryStore.create('videoCalls', {
      participantId,
      callerId: req.user?.userId,
      callerName: req.user?.fullName || req.user?.email || 'Caller',
      callerRole,
      callType: body.call_type,
      appointmentId: body.appointment_id,
      paymentId,
      minutes: body.minutes || 30,
      mode: body.mode || 'video',
      status: 'RINGING',
      createdAt: new Date().toISOString(),
    });
    return { success: true, sessionId: call.id, remoteVideoUrl: '', callData: call };
  }

  @Post('consultation')
  async consultation(@Req() req: any, @Body() body: any) {
    await this.assertAllowed(req, body.medic_id);
    return this.create(req, {
      participant_id: body.medic_id,
      call_type: 'consultation',
      appointment_id: body.appointment_id,
    });
  }

  @Post('pharmacy')
  async pharmacy(@Req() req: any, @Body() body: any) {
    await this.assertAllowed(req, body.pharmacy_id);
    return this.create(req, {
      participant_id: body.pharmacy_id,
      call_type: 'pharmacy',
      appointment_id: body.order_id,
    });
  }

  @Post('emergency')
  async emergency(@Req() req: any, @Body() body: any) {
    if (body.hospital_id) {
      await this.assertAllowed(req, body.hospital_id);
    }
    return this.create(req, {
      participant_id: body.hospital_id,
      call_type: 'emergency',
    });
  }

  @Post('token')
  async token(@Req() req: any, @Body() body: any) {
    const channel = body.channel;
    if (!channel) throw new BadRequestException('channel is required');
    const call = InMemoryStore.findById('videoCalls', String(channel)) as any;
    if (!call) {
      throw new BadRequestException('Invalid call channel');
    }
    const participantUserId = await this.resolveParticipantUserId(call?.participantId);
    const isParticipant =
      req.user?.role === 'SUPER_ADMIN' ||
      req.user?.userId === call?.callerId ||
      req.user?.userId === participantUserId;
    if (!isParticipant) {
      throw new ForbiddenException('You are not allowed to join this call');
    }

    const streamApiKey = this.getStreamApiKey();
    const streamApiSecret = this.getStreamApiSecret();
    const expireSeconds = Number(body.expireSeconds || 3600);
    const uid = String(body.uid || req.user?.userId || '');
    if (!uid) {
      throw new BadRequestException('Unable to resolve user for call token');
    }

    if (streamApiKey && streamApiSecret) {
      const token = this.buildStreamUserToken(uid, streamApiSecret, expireSeconds);
      return {
        provider: 'stream',
        apiKey: streamApiKey,
        token,
        uid,
        channel: String(channel),
        callId: String(channel),
        callType: String(body.callType || 'default'),
        user: {
          id: uid,
          name: req.user?.fullName || req.user?.email || 'User',
          image:
            req.user?.profilePhoto ||
            req.user?.avatarUrl ||
            req.user?.photoUrl ||
            null,
        },
      };
    }

    throw new BadRequestException('Stream credentials are not configured');
  }

  @Post(':id/answer')
  async answer(@Req() req: any, @Param('id') id: string) {
    const call = InMemoryStore.findById('videoCalls', id);
    if (!call) return { success: false };
    const updated = InMemoryStore.update('videoCalls', id, {
      status: 'ACTIVE',
      answeredBy: req.user?.userId,
      answeredAt: new Date().toISOString(),
    });
    const callerId = call?.callerId;
    if (callerId && callerId !== req.user?.userId) {
      this.notificationsGateway.emitToUser(callerId, {
        title: 'Call answered',
        message: `${req.user?.fullName || 'User'} accepted your call.`,
        type: 'video_call',
        data: {
          type: 'video_call',
          sessionId: id,
          status: 'ANSWERED',
          answeredBy: req.user?.userId,
        },
      });
    }
    return { success: true, callData: updated };
  }

  @Post(':id/end')
  async end(@Param('id') id: string, @Body() body: any) {
    const status = body?.status || 'ENDED';
    const call = InMemoryStore.findById('videoCalls', id);
    const updated = InMemoryStore.update('videoCalls', id, {
      status,
      endedBy: body?.ended_by,
      duration: body?.duration,
    });
    if (call) {
      const endedBy = body?.ended_by;
      const participantUserId = await this.resolveParticipantUserId(call?.participantId);
      const counterpartId =
        endedBy && endedBy === call?.callerId ? participantUserId : call?.callerId;
      if (counterpartId && counterpartId !== endedBy) {
        this.notificationsGateway.emitToUser(counterpartId, {
          title: status === 'REJECTED' ? 'Call declined' : status === 'MISSED' ? 'Missed call' : 'Call ended',
          message:
            status === 'REJECTED'
              ? 'Your call was declined.'
              : status === 'MISSED'
                ? 'You have a missed call.'
                : 'Call ended.',
          type: 'video_call',
          data: {
            type: 'video_call',
            sessionId: id,
            status,
            endedBy,
          },
        });
      }
    }
    return updated;
  }

  @Post(':id/toggle-video')
  async toggleVideo(@Param('id') id: string, @Body() body: any) {
    return InMemoryStore.update('videoCalls', id, { videoEnabled: body.enabled });
  }

  @Post(':id/toggle-audio')
  async toggleAudio(@Param('id') id: string, @Body() body: any) {
    return InMemoryStore.update('videoCalls', id, { audioEnabled: body.enabled });
  }

  @Post(':id/toggle-camera')
  async toggleCamera(@Param('id') id: string, @Body() body: any) {
    return InMemoryStore.update('videoCalls', id, { facing: body.facing });
  }

  @Post(':id/hold')
  async hold(@Param('id') id: string, @Body() body: any) {
    const isOnHold = Boolean(body?.isOnHold);
    return InMemoryStore.update('videoCalls', id, {
      isOnHold,
      status: isOnHold ? 'ON_HOLD' : 'ACTIVE',
      holdUpdatedAt: new Date().toISOString(),
    });
  }

  @Post(':id/start-recording')
  async startRecording(@Param('id') id: string) {
    return InMemoryStore.update('videoCalls', id, { recording: true });
  }

  @Post(':id/stop-recording')
  async stopRecording(@Param('id') id: string) {
    return InMemoryStore.update('videoCalls', id, { recording: false });
  }

  @Post(':id/upload-recording')
  async uploadRecording(@Param('id') id: string) {
    return { success: true };
  }

  @Post(':id/chat')
  async chat(@Param('id') id: string, @Body() body: any) {
    return { success: true, message: body.message };
  }

  @Get('history')
  async history() {
    return { calls: InMemoryStore.list('videoCalls') };
  }
}
