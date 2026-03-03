import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';

@WebSocketGateway({
  cors: {
    origin: '*',
  },
})
export class MessagesGateway {
  @WebSocketServer()
  server: any;

  isUserOnline(userId: string) {
    if (!this.server || !userId) return false;
    // Room exists if at least one socket joined for this user
    return this.server.sockets.adapter.rooms.has(userId);
  }

  emitToUser(userId: string, payload: any) {
    if (!this.server || !userId) return;
    this.server.to(userId).emit('chat_message', payload);
  }

  emitToUsers(userIds: string[], payload: any) {
    if (!this.server) return;
    userIds.forEach((userId) => this.emitToUser(userId, payload));
  }

  emitReadReceipt(userId: string, payload: any) {
    if (!this.server || !userId) return;
    this.server.to(userId).emit('chat_read', payload);
  }

  emitDeliveredReceipt(userId: string, payload: any) {
    if (!this.server || !userId) return;
    this.server.to(userId).emit('chat_delivered', payload);
  }

  emitDeleted(userId: string, payload: any) {
    if (!this.server || !userId) return;
    this.server.to(userId).emit('chat_deleted', payload);
  }
}
