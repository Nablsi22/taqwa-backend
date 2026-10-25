import {
  IsString,
  IsEnum,
  IsOptional,
  IsArray,
  IsBoolean,
  ValidateNested,
  IsUUID,
  IsDateString,
} from 'class-validator';
import { Type } from 'class-transformer';

enum AttendanceStatus {
  PRESENT = 'PRESENT',
  LATE = 'LATE',
  ABSENT = 'ABSENT',
}

class StudentAttendanceEntry {
  @IsUUID()
  studentId: string;

  @IsEnum(AttendanceStatus)
  status: AttendanceStatus;

  /**
   * «غائب بعذر». Only valid with status ABSENT. Omitted → an existing excuse
   * on the same record is kept (app versions that predate this field must
   * not silently erase an excuse when they re-save the sheet).
   */
  @IsOptional()
  @IsBoolean()
  excused?: boolean;

  @IsOptional()
  @IsString()
  notes?: string;
}

// Unmarking is a deletion, not a fourth status: the sheet already reads
// "no record" as unmarked, so no existing counter or filter changes.
export class UnmarkAttendanceDto {
  @IsDateString()
  date: string;

  @IsArray()
  @IsUUID(undefined, { each: true })
  studentIds: string[];
}

export class MarkAttendanceDto {
  @IsDateString()
  date: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => StudentAttendanceEntry)
  entries: StudentAttendanceEntry[];
}