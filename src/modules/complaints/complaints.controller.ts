import { Controller, Post, Body, UseGuards, Req, Get } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InMemoryStore } from 'src/common/in-memory.store';

@Controller('complaints')
@UseGuards(AuthGuard('jwt'))
export class ComplaintsController {
  @Post()
  async create(@Req() req: any, @Body() body: any) {
    const record = InMemoryStore.create('complaints', {
      userId: req.user?.userId,
      role: req.user?.role,
      category: body.category || 'General',
      message: body.message,
      status: 'OPEN',
      createdAt: new Date().toISOString(),
    });
    return record;
  }

  @Get('my')
  async listMine(@Req() req: any) {
    return InMemoryStore.list('complaints').filter((c: any) => c.userId === req.user?.userId);
  }
}
