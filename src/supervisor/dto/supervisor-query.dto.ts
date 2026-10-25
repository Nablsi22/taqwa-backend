import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

/** The course to look at. Absent → the active one. */
export class CourseQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'termId يجب أن يكون رقماً صحيحاً' })
  @Min(1, { message: 'termId يجب أن يكون رقم دورة' })
  termId?: number;
}

/** The main screen: discipline over the last `sessions` required days. */
export class DisciplineQueryDto extends CourseQueryDto {
  /**
   * How many required sessions the strip covers. Four by default, which is
   * the same four weeks the «ثابت» rule uses, so the two screens agree.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'sessions يجب أن يكون رقماً صحيحاً' })
  @Min(1, { message: 'sessions لا يقل عن 1' })
  @Max(52, { message: 'sessions لا يزيد عن 52' })
  sessions?: number;
}

export class DayQueryDto extends CourseQueryDto {
  /** YYYY-MM-DD. Absent → the last required session that has records. */
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD',
  })
  date?: string;
}

/** A span of days for «شو سمّعوا». Both absent → the last session day. */
export class RecitationsQueryDto extends CourseQueryDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD',
  })
  from?: string;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, {
    message: 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD',
  })
  to?: string;
}
