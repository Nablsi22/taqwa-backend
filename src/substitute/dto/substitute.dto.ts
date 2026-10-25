import { Type } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day being looked at or claimed. Absent → today in Damascus. */
export class CoverageDayQueryDto {
  @IsOptional()
  @IsString()
  @Matches(ISO_DAY, { message: 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD' })
  date?: string;

  /**
   * Which course's meeting days describe the day. Absent → the active
   * course, which is what the app always wants.
   */
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: 'termId يجب أن يكون رقماً صحيحاً' })
  @Min(1, { message: 'termId يجب أن يكون رقم دورة' })
  termId?: number;
}

/** One حلقة's roster, names only — a substitute needs no more than that. */
export class HalaqaRosterQueryDto extends CoverageDayQueryDto {
  @IsUUID('all', { message: 'instructorId غير صالح' })
  instructorId: string;
}

/** «استلمت هالحلقة اليوم» / undoing it. */
export class CoverageDto {
  /** The حلقة being covered — the instructor its students belong to. */
  @IsUUID('all', { message: 'halaqaInstructorId غير صالح' })
  halaqaInstructorId: string;

  /** YYYY-MM-DD. Absent → today in Damascus. */
  @IsOptional()
  @IsString()
  @Matches(ISO_DAY, { message: 'التاريخ يجب أن يكون بصيغة YYYY-MM-DD' })
  date?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300, { message: 'الملاحظة طويلة' })
  note?: string;
}
