import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'node:crypto';
import { LoginDto } from './dto/login.dto';
import { LoginAttemptsService } from './login-attempts.service';

import { resolveTtl } from './jwt-ttl.util';
@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwt: JwtService,
    private config: ConfigService,
    private attempts: LoginAttemptsService,
  ) {}

  /**
   * Compared against when the username does not exist, so a wrong username
   * costs the same bcrypt time as a wrong password and the answer's timing
   * does not reveal which usernames exist. Same cost (12) as stored hashes.
   */
  private static readonly unknownUserHash: Promise<string> = bcrypt.hash(
    randomBytes(32).toString('hex'),
    12,
  );

  async login(dto: LoginDto) {
    // A username that has had too many wrong passwords waits (429).
    this.attempts.assertAllowed(dto.username);

    // Find user by username
    const user = await this.prisma.user.findUnique({
      where: { username: dto.username },
      include: {
        student: true,
        instructor: true,
      },
    });

    // Verify password — always, so every refusal takes the same time.
    const passwordValid = await bcrypt.compare(
      dto.password,
      user?.passwordHash ?? (await AuthService.unknownUserHash),
    );
    if (!user || !passwordValid || !user.isActive || user.deletedAt) {
      if (!passwordValid) this.attempts.recordFailure(dto.username);
      throw new UnauthorizedException('اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    this.attempts.recordSuccess(dto.username);

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
      expiresIn: resolveTtl(this.config.get<string>('JWT_ACCESS_TTL'), '15m'),
    });

    const refreshToken = this.jwt.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: resolveTtl(this.config.get<string>('JWT_REFRESH_TTL'), '180d'),
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

      if (!user || !user.isActive || user.deletedAt) {
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
          expiresIn: resolveTtl(this.config.get<string>('JWT_ACCESS_TTL'), '15m'),
        }),
        refreshToken: this.jwt.sign(newPayload, {
          secret: this.config.get('JWT_REFRESH_SECRET'),
          expiresIn: resolveTtl(this.config.get<string>('JWT_REFRESH_TTL'), '180d'),
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