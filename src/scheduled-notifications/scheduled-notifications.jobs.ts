import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ATTENDANCE_RULES } from '../attendance-stats/attendance-stats.rules';
import { ScheduledNotificationsService } from './scheduled-notifications.service';

/**
 * The clock of the evening notifications, on the mosque's time (Damascus,
 * permanent UTC+03:00) whatever the server's own zone is.
 *
 *   21:00  «لم تسجّل» reminders + «اتصل واطمئن عليه» alerts
 *   21:30  the same again — a catch-up if the server was restarting at 9 pm;
 *          anything already sent is skipped (scheduled_notifications)
 *   23:00  alerts recorded late + the course director's summary
 *
 * `SCHEDULED_NOTIFICATIONS=off` in the environment stops all three without a
 * redeploy of the code (Railway restarts the service on a variable change).
 */
@Injectable()
export class ScheduledNotificationsJobs {
  private readonly logger = new Logger('EveningNotifications');

  constructor(private readonly service: ScheduledNotificationsService) {}

  private get enabled(): boolean {
    const off =
      (process.env.SCHEDULED_NOTIFICATIONS ?? '').trim().toLowerCase() ===
      'off';
    if (off) this.logger.log('SCHEDULED_NOTIFICATIONS=off — skipped');
    return !off;
  }

  @Cron('0,30 21 * * *', {
    name: 'attendance-reminder',
    timeZone: ATTENDANCE_RULES.localTimeZone,
    waitForCompletion: true,
  })
  async evening(): Promise<void> {
    if (!this.enabled) return;
    await this.service.runEvening();
  }

  @Cron('0 23 * * *', {
    name: 'director-summary',
    timeZone: ATTENDANCE_RULES.localTimeZone,
    waitForCompletion: true,
  })
  async night(): Promise<void> {
    if (!this.enabled) return;
    await this.service.runNight();
  }
}
