import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsDateString,
  MaxLength,
  Matches,
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  IsInt,
  Min,
  Max,
} from 'class-validator';

export class CreateTermDto {
  // Slug-like identifier, e.g., "summer-2026"
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  @Matches(/^[a-z0-9-]+$/i, {
    message: 'الاسم يجب أن يحتوي على أحرف لاتينية وأرقام و"-" فقط',
  })
  name!: string;

  // Display name in Arabic, e.g., "الدورة الصيفية 2026"
  @IsString()
  @IsNotEmpty()
  @MaxLength(128)
  nameAr!: string;

  @IsDateString()
  startDate!: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Meeting days as ISO weekdays: Monday = 1 … Sunday = 7. Required days can
   * be missed; optional days only ever count in a student's favour.
   * Example — winter: requiredDays [6] (Saturday), optionalDays [4] (Thursday).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true, message: 'أيام الدوام من 1 (الاثنين) إلى 7 (الأحد)' })
  @Max(7, { each: true, message: 'أيام الدوام من 1 (الاثنين) إلى 7 (الأحد)' })
  requiredDays?: number[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(7)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true, message: 'أيام الدوام من 1 (الاثنين) إلى 7 (الأحد)' })
  @Max(7, { each: true, message: 'أيام الدوام من 1 (الاثنين) إلى 7 (الأحد)' })
  optionalDays?: number[];
}