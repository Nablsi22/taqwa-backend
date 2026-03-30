import {
  IsString,
  IsInt,
  IsNumber,
  IsEnum,
  IsOptional,
  IsBoolean,
  IsDateString,
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

  @IsInt()
  @Min(1)
  @Max(114)
  surahNumber: number;

  @IsNumber()
  @Min(0)
  pagesRecited: number;

  @IsBoolean()
  @IsOptional()
  isCompleteSura?: boolean;

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
