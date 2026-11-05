import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { randomBytes, randomUUID } from 'node:crypto';
import { LoginDto } from './dto/login.dto';
import { LoginAttemptsService } from './login-attempts.service';
import { resolveTtl, ttlToSeconds } from './jwt-ttl.util';
import {
  DEFAULT_WEB_REFRESH_TTL,
  DEFAULT_WEB_SESSION_MAX,
  WEB_TOKEN_AUDIENCE,
} from './web-session';

/** The claims every token of ours is signed with. */
interface TokenUser {
  id: string;
  username: string;
  role: string;
}

/** A signed web refresh token and the cookie lifetime that matches it. */
export interface WebRefreshGrant {
  token: string;
  maxAge: number;
}

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
      const payload = this.jwt.verify<{ sub: string; aud?: string | string[] }>(token, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });

      // A browser's refresh token (aud "taqwa-web") only works through the
      // cookie endpoint, never here.
      if (payload?.aud === WEB_TOKEN_AUDIENCE) {
        throw new UnauthorizedException('جلسة غير صالحة');
      }

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

  // ═══════════════════════════════════════════════════════════════════
  // WEB SESSION — refresh token in an HttpOnly cookie (web-session.ts).
  // ═══════════════════════════════════════════════════════════════════

  private signAccessToken(user: TokenUser): string {
    return this.jwt.sign(
      { sub: user.id, username: user.username, role: user.role },
      {
        secret: this.config.get('JWT_SECRET'),
        expiresIn: resolveTtl(this.config.get<string>('JWT_ACCESS_TTL'), '15m'),
      },
    );
  }

  /**
   * Idle lifetime of one web refresh token, and the absolute lifetime of a
   * web session however often it is refreshed.
   */
  private webSessionLimits(): { idle: number; max: number } {
    const idle = ttlToSeconds(
      this.config.get<string>('WEB_REFRESH_TTL'),
      DEFAULT_WEB_REFRESH_TTL,
    );
    const max = ttlToSeconds(
      this.config.get<string>('WEB_SESSION_MAX'),
      DEFAULT_WEB_SESSION_MAX,
    );
    return { idle: Math.max(idle, 60), max: Math.max(max, 60) };
  }

  /** Null when the session's absolute lifetime is used up. */
  private signWebRefresh(
    user: TokenUser,
    sessionStart: number,
    now: number,
  ): WebRefreshGrant | null {
    const { idle, max } = this.webSessionLimits();
    const remaining = sessionStart + max - now;
    if (remaining <= 0) return null;
    const lifetime = Math.min(idle, remaining);
    const token = this.jwt.sign(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
        typ: 'refresh',
        ses: sessionStart,
      },
      {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        audience: WEB_TOKEN_AUDIENCE,
        expiresIn: lifetime,
        jwtid: randomUUID(),
      },
    );
    return { token, maxAge: lifetime };
  }

  /**
   * Same checks as [login] (per-account lock, equal timing, active account);
   * the phone refresh token it creates is dropped and a web one issued.
   */
  async webLogin(dto: LoginDto) {
    const result = await this.login(dto);
    const now = Math.floor(Date.now() / 1000);
    const refresh = this.signWebRefresh(result.user, now, now);
    if (!refresh) throw new UnauthorizedException('الرجاء تسجيل الدخول مرة أخرى');
    return { accessToken: result.accessToken, user: result.user, refresh };
  }

  /** Validates the cookie's token and rotates it; 401 on any doubt. */
  async webRefresh(token: string | undefined) {
    const invalid = () => new UnauthorizedException('الرجاء تسجيل الدخول مرة أخرى');
    if (!token) throw invalid();

    let payload: { sub?: unknown; ses?: unknown; typ?: unknown };
    try {
      payload = this.jwt.verify(token, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
        audience: WEB_TOKEN_AUDIENCE,
      });
    } catch {
      throw invalid();
    }
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.typ !== 'refresh' ||
      typeof payload.sub !== 'string' ||
      typeof payload.ses !== 'number' ||
      payload.ses > now + 60
    ) {
      throw invalid();
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.isActive || user.deletedAt) throw invalid();

    const refresh = this.signWebRefresh(user, payload.ses, now);
    if (!refresh) throw invalid();
    return { accessToken: this.signAccessToken(user), refresh };
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