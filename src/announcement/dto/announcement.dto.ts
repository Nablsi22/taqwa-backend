import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsBoolean,
  IsDateString,
  MaxLength,
} from 'class-validator';

// ── Create DTO ──
export class CreateAnnouncementDto {
  @IsString()
  @IsNotEmpty({ message: 'عنوان الإعلان مطلوب' })
  @MaxLength(200, { message: 'العنوان يجب أن لا يتجاوز 200 حرف' })
  title: string;

  @IsString()
  @IsNotEmpty({ message: 'نص الإعلان مطلوب' })
  @MaxLength(5000, { message: 'النص يجب أن لا يتجاوز 5000 حرف' })
  body: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsDateString({}, { message: 'تاريخ الانتهاء غير صالح' })
  expiresAt?: string;
}

// ── Update DTO ──
export class UpdateAnnouncementDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  body?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
