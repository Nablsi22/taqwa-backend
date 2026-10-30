import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsInt,
  IsOptional,
  IsEnum,
  Matches,
  Min,
} from 'class-validator';
import { RecitationRating } from '@prisma/client';

export class AwardPointsDto {
  @IsUUID()
  @IsNotEmpty({ message: 'معرف الطالب مطلوب' })
  studentId: string;

  @IsUUID()
  @IsNotEmpty({ message: 'معرف الفئة مطلوب' })
  categoryId: string;

  @IsInt()
  @Min(0, { message: 'عدد النقاط يجب أن يكون 0 أو أكثر' })
  amount: number;

  @IsOptional()
  @IsEnum(RecitationRating, { message: 'تقييم غير صالح' })
  rating?: RecitationRating;

  @IsOptional()
  @IsString()
  description?: string;

  /**
   * «تاريخ التسجيل» — 'YYYY-MM-DD' in the mosque's calendar. Optional:
   * older APKs omit it and the entry is dated now. The range (inside the
   * active course, not in the future) is checked by
   * TermsService.resolveRecordTimestamp.
   */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة التاريخ غير صحيحة' })
  date?: string;
}