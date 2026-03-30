import { IsString, IsOptional, IsDateString, IsUUID } from 'class-validator';

export class UpdateStudentDto {
  @IsOptional()
  @IsString()
  fullName?: string;

  @IsOptional()
  @IsString()
  fatherName?: string;

  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @IsOptional()
  @IsUUID()
  instructorId?: string;

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
  grade?: string;


  @IsOptional()
  @IsString()
  password?: string;
  

  }