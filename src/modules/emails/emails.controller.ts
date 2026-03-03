import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';
import { EmailsService } from './emails.service';

@Controller('emails')
export class EmailsController {
  constructor(private emails: EmailsService) {}

  @Post('inbound')
  async inbound(@Body() body: any) {
    return InMemoryStore.create('emails', {
      direction: 'inbound',
      payload: body,
      receivedAt: new Date().toISOString(),
    });
  }

  @Post('events')
  async events(@Body() body: any) {
    return InMemoryStore.create('emails', {
      direction: 'event',
      payload: body,
      receivedAt: new Date().toISOString(),
    });
  }

  @Post('send')
  @UseGuards(AuthGuard('jwt'))
  async send(@Req() req: any, @Body() body: any) {
    const role = req.user?.role;
    if (role !== 'SUPER_ADMIN') {
      return { success: false, message: 'Not authorized' };
    }
    return this.emails.sendTransactional(body);
  }

  @Get('inbound')
  @UseGuards(AuthGuard('jwt'))
  async list(@Req() req: any) {
    const role = req.user?.role;
    if (role !== 'SUPER_ADMIN') {
      return [];
    }
    return InMemoryStore.list('emails');
  }
}
