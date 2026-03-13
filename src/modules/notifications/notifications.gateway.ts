import {
  WebSocketGateway,
  WebSocketServer,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';

type PresenceSocket = {
  id: string;
  join: (room: string) => void;
  emit: (event: string, payload: unknown) => void;
};

type PresenceServer = {
  emit: (event: string, payload: unknown) => void;
  to: (room: string) => { emit: (event: string, payload: unknown) => void };
};

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class NotificationsGateway {
  @WebSocketServer()
  server!: PresenceServer;

  private readonly socketToUser = new Map<string, string>();
  private readonly userToSockets = new Map<string, Set<string>>();
  private readonly userLastSeen = new Map<string, string>();
  private readonly userOnlineSince = new Map<string, string>();

  private normalizeUserId(userId: unknown) {
    if (userId === null || userId === undefined) return null;
    const id = String(userId).trim();
    return id.length > 0 ? id : null;
  }

  private getOnlineUserIds() {
    return Array.from(this.userToSockets.entries())
      .filter(([, sockets]) => sockets.size > 0)
      .map(([userId]) => userId);
  }

  listOnlineUserIds() {
    return this.getOnlineUserIds();
  }

  getPresenceMeta(userId: string) {
    const id = this.normalizeUserId(userId);
    if (!id) {
      return { isOnline: false, onlineSince: null, lastSeenAt: null };
    }
    const isOnline = this.isUserOnline(id);
    return {
      isOnline,
      onlineSince: isOnline ? this.userOnlineSince.get(id) || null : null,
      lastSeenAt: this.userLastSeen.get(id) || null,
    };
  }

  private markOnline(userId: string, socketId: string) {
    const existingUser = this.socketToUser.get(socketId);
    if (existingUser && existingUser !== userId) {
      const prevSockets = this.userToSockets.get(existingUser);
      if (prevSockets) {
        prevSockets.delete(socketId);
        if (prevSockets.size === 0) {
          this.userToSockets.delete(existingUser);
          this.server?.emit('user_offline', { userId: existingUser, isOnline: false, status: 'offline' });
          this.server?.emit('presence_update', { userId: existingUser, isOnline: false, status: 'offline' });
        }
      }
    }

    const sockets = this.userToSockets.get(userId) || new Set<string>();
    const wasOffline = sockets.size === 0;
    sockets.add(socketId);
    this.userToSockets.set(userId, sockets);
    this.socketToUser.set(socketId, userId);

    if (wasOffline) {
      const now = new Date().toISOString();
      this.userOnlineSince.set(userId, now);
      this.server?.emit('user_online', { userId, isOnline: true, status: 'online' });
      this.server?.emit('presence_update', { userId, isOnline: true, status: 'online' });
    }
  }

  private markOfflineBySocket(socketId: string) {
    const userId = this.socketToUser.get(socketId);
    if (!userId) return;
    this.socketToUser.delete(socketId);
    const sockets = this.userToSockets.get(userId);
    if (!sockets) return;

    sockets.delete(socketId);
    if (sockets.size === 0) {
      const now = new Date().toISOString();
      this.userToSockets.delete(userId);
      this.userLastSeen.set(userId, now);
      this.userOnlineSince.delete(userId);
      this.server?.emit('user_offline', { userId, isOnline: false, status: 'offline' });
      this.server?.emit('presence_update', { userId, isOnline: false, status: 'offline' });
    }
  }

  @SubscribeMessage('register')
  handleRegister(
    @MessageBody() data: { userId: string },
    @ConnectedSocket() client: PresenceSocket,
  ) {
    const userId = this.normalizeUserId(data?.userId);
    if (!userId) return;
    client.join(userId);
    this.markOnline(userId, client.id);
    client.emit('online_users', this.getOnlineUserIds());
    client.emit('presence_snapshot', this.getOnlineUserIds());
  }

  @SubscribeMessage('get_online_users')
  handleGetOnlineUsers(@ConnectedSocket() client: PresenceSocket) {
    client.emit('online_users', this.getOnlineUserIds());
    client.emit('users_online', this.getOnlineUserIds());
  }

  @SubscribeMessage('presence:sync')
  handlePresenceSync(@ConnectedSocket() client: PresenceSocket) {
    client.emit('presence_snapshot', this.getOnlineUserIds());
  }

  handleDisconnect(client: PresenceSocket) {
    this.markOfflineBySocket(client.id);
  }

  isUserOnline(userId: string) {
    const id = this.normalizeUserId(userId);
    if (!id) return false;
    return (this.userToSockets.get(id)?.size || 0) > 0;
  }

  emitToUser(userId: string, payload: unknown) {
    if (!this.server || !userId) return;
    this.server.to(userId).emit('notification', payload);
  }

  emitToUsers(userIds: string[], payload: unknown) {
    if (!this.server) return;
    userIds.forEach((userId) => {
      this.emitToUser(userId, payload);
    });
  }
}
