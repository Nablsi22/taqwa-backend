import {
  IsString,
  IsInt,
  IsNumber,
  IsEnum,
  IsOptional,
  IsDateString,
  IsArray,
  ArrayMinSize,
  ValidateIf,
  Min,
  Max,
} from 'class-validator';

export enum RecitationRatingDto {
  VERY_GOOD = 'VERY_GOOD',
  GOOD = 'GOOD',
  REPEAT = 'REPEAT',
  DID_NOT_MEMORIZE = 'DID_NOT_MEMORIZE',
  MAQRAA = 'MAQRAA',
}

export class CreateRecitationDto {
  @IsString()
  studentId: string;

  // ───── LEGACY fields (Phase 1, kept optional for backward compat) ─────
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(114, { each: true })
  surahNumbers?: number[];

  @IsOptional()
  @IsNumber()
  @Min(0)
  pagesRecited?: number;

  // ───── NEW Phase 2B aya-range fields ─────
  @IsOptional() @IsInt() @Min(1) @Max(114)
  startSurah?: number;

  @ValidateIf((o) => o.startSurah !== undefined)
  @IsInt() @Min(1)
  startAya?: number;

  @IsOptional() @IsInt() @Min(1) @Max(114)
  endSurah?: number;

  @ValidateIf((o) => o.startAya !== undefined)
  @IsInt() @Min(1)
  endAya?: number;

  // ───── Common ─────
  @IsEnum(RecitationRatingDto)
  rating: RecitationRatingDto;

  @IsString()
  @IsOptional()
  homework?: string;

  @IsDateString()
  date: string;
}

export class BulkMaqraaDto {
  @IsString({ each: true })
  studentIds: string[];

  @IsInt() @Min(1) @Max(114)
  surahNumber: number;

  @IsNumber() @Min(0) @IsOptional()
  pagesRecited?: number;

  @IsDateString()
  date: string;
}