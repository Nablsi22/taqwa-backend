import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
  ) {}

  async login(dto: LoginDto) {
    // Find user by username
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
      include: {
        student: true,
        instructor: true,
      },
    });

    if (!user || !user.isActive || user.deletedAt) {
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
    }

    // Verify password
    const passwordValid = await bcrypt.compare(dto.password, user.passwordHash);
    if (!passwordValid) {
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
    }

    // Update last login
    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    // Generate tokens
    const payload = {
      sub: user.id,
      username: user.username,
      role: user.role,
    };

    const accessToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_SECRET'),
      expiresIn: '15m',
    });

    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: '7d',
    });

    // Build profile based on role
    let profile: any = null;
    if (user.student) {
      profile = {
        id: user.student.id,
        fullName: user.student.fullName,
        fatherName: user.student.fatherName,
        instructorId: user.student.instructorId,
      };
    } else if (user.instructor) {
      profile = {
        id: user.instructor.id,
        fullName: user.instructor.fullName,
        specialty: user.instructor.specialty,
      };
    }

    return {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        username: user.username,
        role: user.role,
        profile,
      },
    };
  }

  async refreshToken(token: string) {
    try {
      const payload = this.jwt.verify(token, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('جلسة غير صالحة');
      }

      const newPayload = {
        sub: user.id,
        username: user.username,
        role: user.role,
      };

      return {
        accessToken: this.jwt.sign(newPayload, {
          secret: this.config.get('JWT_SECRET'),
          expiresIn: '15m',
        }),
        refreshToken: this.jwt.sign(newPayload, {
          secret: this.config.get('JWT_REFRESH_SECRET'),
          expiresIn: '7d',
        }),
      };
    } catch {
      throw new UnauthorizedException('الرجاء تسجيل الدخول مرة أخرى');
    }
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        student: true,
        instructor: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('المستخدم غير موجود');
    }

    return {
      id: user.id,
      username: user.username,
      role: user.role,
      profile: user.student || user.instructor,
    };
  }
}