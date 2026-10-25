import {
  IsBoolean,
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Same rules as an instructor's username and password. */
export class CreateSupervisorAccountDto {
  @IsString()
  @IsNotEmpty({ message: 'اسم المستخدم مطلوب' })
  @MinLength(3, { message: 'اسم المستخدم 3 أحرف على الأقل' })
  @MaxLength(50)
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'اسم المستخدم: أحرف إنكليزية وأرقام و _ فقط',
  })
  username: string;

  @IsString()
  @MinLength(6, { message: 'كلمة المرور 6 أحرف على الأقل' })
  @MaxLength(100)
  password: string;
}

export class SupervisorPasswordDto {
  @IsString()
  @MinLength(6, { message: 'كلمة المرور 6 أحرف على الأقل' })
  @MaxLength(100)
  password: string;
}

export class SupervisorActiveDto {
  @IsBoolean({ message: 'isActive يجب أن يكون true أو false' })
  isActive: boolean;
}
