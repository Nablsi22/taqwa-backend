import { IsOptional, IsString, Matches } from 'class-validator';

/** YYYY-MM-DD on the Damascus calendar. Absent → today. */
export class NotificationDayQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD',
  })
  date?: string;
}
