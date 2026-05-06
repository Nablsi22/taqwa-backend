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
  ValidateNested,
  Min,
  Max,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum RecitationRatingDto {
  VERY_GOOD = 'VERY_GOOD',
  GOOD = 'GOOD',
  REPEAT = 'REPEAT',
  DID_NOT_MEMORIZE = 'DID_NOT_MEMORIZE',
  MAQRAA = 'MAQRAA',
}

export enum BatchSegmentType {
  FULL_SURA = 'FULL_SURA',
  AYA_RANGE = 'AYA_RANGE',
}

// ═══════════════════════════════════════════════════════════════════
// LEGACY single-segment DTO (still used by POST /recitations)
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// PER-SEGMENT DTO (NEW) — each segment carries its own rating
// ═══════════════════════════════════════════════════════════════════
//
// Discriminated by `type`:
//   { type: 'FULL_SURA', surahNumbers: [89, 90], rating: 'VERY_GOOD' }
//   { type: 'AYA_RANGE', startSurah: 89, startAya: 1, endAya: 15, rating: 'GOOD' }
//
// Shape (which fields are required for which `type`) is validated in
// the service so we can return position-aware Arabic messages — same
// pattern used elsewhere in this controller.
//
export class BatchSegmentDto {
  @IsEnum(BatchSegmentType)
  type: BatchSegmentType;

  @IsEnum(RecitationRatingDto)
  rating: RecitationRatingDto;

  // FULL_SURA fields
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(114, { each: true })
  surahNumbers?: number[];

  // AYA_RANGE fields
  @IsOptional() @IsInt() @Min(1) @Max(114)
  startSurah?: number;

  @IsOptional() @IsInt() @Min(1)
  startAya?: number;

  @IsOptional() @IsInt() @Min(1)
  endAya?: number;
}

// ═══════════════════════════════════════════════════════════════════
// MULTI-SEGMENT BATCH DTO
// ═══════════════════════════════════════════════════════════════════
//
// Parent `rating` is OPTIONAL and is used ONLY for the DID_NOT_MEMORIZE
// placeholder path (where no segments are submitted). For real multi-
// segment sessions, every element of `segments[]` carries its own rating.
//
export class CreateRecitationBatchDto {
  @IsString()
  studentId: string;

  @IsDateString()
  date: string;

  @IsOptional()
  @IsEnum(RecitationRatingDto)
  rating?: RecitationRatingDto;

  @IsString()
  @IsOptional()
  homework?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BatchSegmentDto)
  segments: BatchSegmentDto[];
}

// ═══════════════════════════════════════════════════════════════════
// BULK MAQRAA — unchanged
// ═══════════════════════════════════════════════════════════════════
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