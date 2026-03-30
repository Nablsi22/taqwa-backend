import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsInt,
  IsOptional,
  IsEnum,
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
}