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

// ═══════════════════════════════════════════════════════════
// LEGACY single-segment DTO (still used by old endpoint)
// ═══════════════════════════════════════════════════════════
export class CreateRecitationDto {
  @IsString()
  studentId: string;

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

  @IsEnum(RecitationRatingDto)
  rating: RecitationRatingDto;

  @IsString()
  @IsOptional()
  homework?: string;

  @IsDateString()
  date: string;
}

// ═══════════════════════════════════════════════════════════
// NEW — multi-segment batch DTO (mixed full-sura + aya-range)
// ═══════════════════════════════════════════════════════════
//
// Each segment is either:
//   { type: 'FULL_SURA', surahNumbers: [89, 90] }
//   { type: 'AYA_RANGE', startSurah: 89, startAya: 1, endAya: 15 }
//
// Validated shallowly here; deep shape-validation happens in the service
// so we can return Arabic error messages consistent with the rest of the API.
//
export class CreateRecitationBatchDto {
  @IsString()
  studentId: string;

  @IsDateString()
  date: string;

  @IsEnum(RecitationRatingDto)
  rating: RecitationRatingDto;

  @IsString()
  @IsOptional()
  homework?: string;

  @IsArray()
  segments: any[];
}

// ═══════════════════════════════════════════════════════════
// BULK MAQRAA — unchanged
// ═══════════════════════════════════════════════════════════
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