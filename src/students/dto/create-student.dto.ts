import {
  IsString,
  IsOptional,
  IsDateString,
  IsUUID,
  IsNotEmpty,
  Matches,
} from 'class-validator';

export class CreateStudentDto {
  @IsString()
  @IsNotEmpty({ message: 'الاسم الكامل مطلوب' })
  fullName: string;

  @IsString()
  @IsNotEmpty({ message: 'اسم الأب مطلوب' })
  fatherName: string;

  @IsDateString({}, { message: 'تاريخ الميلاد غير صالح' })
  dateOfBirth: string;

  @IsUUID('4', { message: 'معرف المعلم غير صالح' })
  instructorId: string;

  @IsOptional()
  @IsString()
  school?: string;

  @IsOptional()
  @IsString()
  address?: string;

  /**
   * Parent's primary phone — required.
   * Syrian formats accepted:
   *   +963XXXXXXXXX  (international, 9 digits after country code)
   *   963XXXXXXXXX   (without +)
   *   09XXXXXXXX     (local, 10 digits starting with 09)
   */
  @IsString()
  @IsNotEmpty({ message: 'رقم هاتف ولي الأمر مطلوب' })
  @Matches(/^(\+?963\d{9}|09\d{8})$/, {
    message: 'رقم الهاتف غير صالح. الصيغة: +963XXXXXXXXX أو 09XXXXXXXX',
  })
  phone1: string;

  @IsOptional()
  @IsString()
  @Matches(/^(\+?963\d{9}|09\d{8})$/, {
    message: 'رقم الهاتف الثاني غير صالح',
  })
  phone2?: string;

  @IsOptional()
  @IsString()
  grade?: string;
}