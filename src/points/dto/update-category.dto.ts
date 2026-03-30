import { IsInt, IsOptional, IsString, IsBoolean, Min } from 'class-validator';

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  nameAr?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  defaultValue?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsBoolean()
  hasRating?: boolean;
}
