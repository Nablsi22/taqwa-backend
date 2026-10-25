import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';

/**
 * `termId` is the course to look at. Absent → the active course. Unlike the
 * points routes there is no `0 = all courses` here: attendance statistics are
 * always about one course, whose meeting days define what a session is.
 */
export class CourseQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'termId يجب أن يكون رقماً صحيحاً' })
  @Min(1, { message: 'termId يجب أن يكون رقم دورة' })
  termId?: number;
}

export class StudentsQueryDto extends CourseQueryDto {
  @IsOptional()
  @IsUUID('all', { message: 'instructorId غير صالح' })
  instructorId?: string;
}

export class DayQueryDto extends StudentsQueryDto {
  /** YYYY-MM-DD. Absent → the last required session that has records. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD',
  })
  date?: string;
}

export class CalendarQueryDto {
  /** YYYY-MM. Absent → the current month in Damascus. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'الشهر يجب أن يكون بصيغة YYYY-MM',
  })
  month?: string;
}
