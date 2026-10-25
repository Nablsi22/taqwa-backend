import {
  IsString,
  IsOptional,
  IsDateString,
  MaxLength,
  IsArray,
  ArrayMaxSize,
  ArrayUnique,
  IsInt,
  Min,
  Max,
} from 'class-validator';

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