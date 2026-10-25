import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { localToday } from '../attendance-stats/meeting-days';
import { ATTENDANCE_RULES } from '../attendance-stats/attendance-stats.rules';
import { NotificationDayQueryDto } from './dto/scheduled-notifications-query.dto';
import { ScheduledNotificationsService } from './scheduled-notifications.service';

/**
 * The evening notifications, for the admin only: what would go out, what
 * went out, and a test sent to his own phone. The notifications themselves
 * are sent by the scheduled jobs, never by a request.
 */
@Controller('api/v1/scheduled-notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADMIN')
export class ScheduledNotificationsController {
  constructor(private readonly service: ScheduledNotificationsService) {}

  /** GET /scheduled-notifications/preview?date=2026-10-24 — sends nothing, records nothing. */
  @Get('preview')
  preview(@Query() q: NotificationDayQueryDto) {
    return this.service.preview(q.date);
  }

  /** GET /scheduled-notifications/log?date=2026-10-31 — what was sent that day. */
  @Get('log')
  log(@Query() q: NotificationDayQueryDto) {
    return this.service.log(
      q.date ?? localToday(ATTENDANCE_RULES.localTimeZone),
    );
  }

  /** POST /scheduled-notifications/test — the last session's summary, to the caller's phone. */
  @Post('test')
  @HttpCode(200)
  test(@Req() req: { user: { id: string } }) {
    return this.service.sendSample(req.user.id);
  }
}
