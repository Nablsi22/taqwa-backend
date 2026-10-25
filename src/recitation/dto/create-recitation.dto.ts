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

/**
 * FULL_SURA is retired but still listed here on purpose.
 *
 * Roughly a hundred instructors are running installed APKs that may still
 * send it. Keeping the value means those requests fail validation-free and
 * reach the service, which answers with FULL_SURA_RETIRED_MESSAGE — a
 * sentence telling the instructor to update the app. Dropping the value
 * would instead return a generic "type must be one of the following values"
 * error that nobody in the mosque can act on.
 */
export enum BatchSegmentType {
  FULL_SURA = 'FULL_SURA',
  AYA_RANGE = 'AYA_RANGE',
}

// ═══════════════════════════════════════════════════════════════════
// SINGLE-SEGMENT DTO (POST /recitations)
//
// A recitation is a verse range: startSurah + startAya + endAya. The three
// range rules the form promises are checked in three places, deliberately:
//   • here          — shape and integer bounds (start >= 1, surah 1..114)
//   • validateRange — the ayah-count ceiling, which needs Quran metadata
//   • the database  — recitations_verse_range_chk, so nothing gets in
//                     through another client or a manual query
//
// `surahNumbers` / `pagesRecited` survive only so an older client's request
// still parses and can be answered with FULL_SURA_RETIRED_MESSAGE instead of
// a validation dump. Nothing reads them any more.
// ═══════════════════════════════════════════════════════════════════
export class CreateRecitationDto {
  @IsString()
  studentId: string;

  /** @deprecated retired shape — accepted only to be refused politely. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(114, { each: true })
  surahNumbers?: number[];

  /** @deprecated pages are computed from the verse range, never supplied. */
  @IsOptional()
  @IsNumber()
  @Min(0)
  pagesRecited?: number;

  @IsOptional() @IsInt() @Min(1) @Max(114)
  startSurah?: number;

  @ValidateIf((o) => o.startSurah !== undefined)
  @IsInt({ message: 'آية البداية يجب أن تكون رقماً صحيحاً' })
  @Min(1, { message: 'آية البداية يجب أن تكون 1 أو أكثر' })
  startAya?: number;

  @IsOptional() @IsInt() @Min(1) @Max(114)
  endSurah?: number;

  @ValidateIf((o) => o.startAya !== undefined)
  @IsInt({ message: 'آية النهاية يجب أن تكون رقماً صحيحاً' })
  @Min(1, { message: 'آية النهاية يجب أن تكون 1 أو أكثر' })
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
// The one accepted shape:
//   { type: 'AYA_RANGE', startSurah: 89, startAya: 1, endAya: 15, rating: 'GOOD' }
//
// Per-segment completeness and the ayah-count ceiling are validated in the
// service so the error can name the segment position in Arabic — the same
// pattern used elsewhere in this controller.
//
export class BatchSegmentDto {
  @IsEnum(BatchSegmentType)
  type: BatchSegmentType;

  @IsEnum(RecitationRatingDto)
  rating: RecitationRatingDto;

  /** @deprecated retired shape — accepted only to be refused politely. */
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(114, { each: true })
  surahNumbers?: number[];

  // ── Verse range ──
  @IsOptional() @IsInt() @Min(1) @Max(114)
  startSurah?: number;

  @IsOptional()
  @IsInt({ message: 'آية البداية يجب أن تكون رقماً صحيحاً' })
  @Min(1, { message: 'آية البداية يجب أن تكون 1 أو أكثر' })
  startAya?: number;

  @IsOptional()
  @IsInt({ message: 'آية النهاية يجب أن تكون رقماً صحيحاً' })
  @Min(1, { message: 'آية النهاية يجب أن تكون 1 أو أكثر' })
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