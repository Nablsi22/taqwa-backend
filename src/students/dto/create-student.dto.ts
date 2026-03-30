import { IsString, IsOptional, IsDateString, IsUUID } from 'class-validator';

export class CreateStudentDto {
  @IsString()
  fullName: string;

  @IsString()
  fatherName: string;

  @IsDateString()
  dateOfBirth: string;

  @IsUUID()
  instructorId: string;

  @IsOptional()
  @IsString()
  school?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsString()
  phone1?: string;

  @IsOptional()
  @IsString()
  phone2?: string;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  grade?: string;
}