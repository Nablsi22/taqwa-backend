import { IsString, IsArray, IsBoolean, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class InstructorAttendanceEntryDto {
  @IsString()
  instructorId: string;

  @IsBoolean()
  present: boolean;
}

export class MarkInstructorAttendanceDto {
  @IsString()
  instructorId: string;

  @IsString()
  date: string;

  @IsBoolean()
  present: boolean;
}

export class MarkBulkInstructorAttendanceDto {
  @IsString()
  date: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => InstructorAttendanceEntryDto)
  entries: InstructorAttendanceEntryDto[];
}
