import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsDateString,
  MaxLength,
  Matches,
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
}