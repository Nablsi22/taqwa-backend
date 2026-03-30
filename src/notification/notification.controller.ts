import { Controller, Post, Delete, Body, Req, UseGuards } from '@nestjs/common';
import { NotificationService } from './notification.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';

@Controller('api/v1/notifications')
@UseGuards(JwtAuthGuard)
export class NotificationController {
  constructor(private readonly notificationService: NotificationService) {}

  /**
   * POST /notifications/register-token
   * Register FCM token for push notifications
   */
  @Post('register-token')
  async registerToken(
    @Body() body: { token: string },
    @Req() req: any,
  ) {
    const userId = req.user.id;
    return this.notificationService.registerToken(userId, body.token);
  }

  /**
   * DELETE /notifications/remove-token
   * Remove FCM token (called on logout)
   */
  @Delete('remove-token')
  async removeToken(@Req() req: any) {
    const userId = req.user.id;
    return this.notificationService.removeToken(userId);
  }
}
