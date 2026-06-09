import { IsString, IsOptional, IsDateString, MaxLength } from 'class-validator';

export class UpdateTermDto {
  @IsOptional()
  @IsString()
  @MaxLength(128)
  nameAr?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string | null;
}