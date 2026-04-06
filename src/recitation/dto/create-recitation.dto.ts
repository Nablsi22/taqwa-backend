import {
  IsString,
  IsInt,
  IsNumber,
  IsEnum,
  IsOptional,
  IsDateString,
  IsArray,
  ArrayMinSize,
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

  /**
   * Array of surah numbers selected by the instructor.
   * Always at least 1. For single-surah entries the array has one element;
   * for multi-surah entries (e.g. several short surahs in Juz 30) it has many.
   */
  @IsArray()
  @ArrayMinSize(1)
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(114, { each: true })
  surahNumbers: number[];

  @IsNumber()
  @Min(0)
  pagesRecited: number;

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

  @IsInt()
  @Min(1)
  @Max(114)
  surahNumber: number;

  @IsNumber()
  @Min(0)
  @IsOptional()
  pagesRecited?: number;

  @IsDateString()
  date: string;
}