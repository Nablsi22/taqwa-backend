import {
  Controller,
  Post,
  Get,
  Body,
  HttpCode,
  Req,
  Res,
  UseGuards,
  Request,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import {
  assertTrustedWebRequest,
  readRefreshCookie,
  serializeClearedRefreshCookie,
  serializeRefreshCookie,
} from './web-session';

@Controller('api/v1/auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  // Per caller, on top of the per-account lock in LoginAttemptsService.
  // Generous enough for a mosque's Wi-Fi, where many phones share one
  // address at the start of a session.
  @Post('login')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Post('refresh')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async refresh(@Body('refreshToken') refreshToken: string) {
    return this.authService.refreshToken(refreshToken);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async getMe(@Request() req: any) {
    return this.authService.getMe(req.user.id);
  }

  // ═══════════════════════════════════════════════════════════════════
  // WEB APP (browser) — the refresh token travels only in an HttpOnly
  // cookie and is never readable by the page. See web-session.ts.
  // The response bodies carry the short-lived access token only.
  // ═══════════════════════════════════════════════════════════════════

  @Post('web/login')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async webLogin(
    @Body() dto: LoginDto,
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    assertTrustedWebRequest(req);
    const result = await this.authService.webLogin(dto);
    res.setHeader('Set-Cookie', serializeRefreshCookie(result.refresh.token, result.refresh.maxAge));
    return { accessToken: result.accessToken, user: result.user };
  }

  @Post('web/refresh')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async webRefresh(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ) {
    assertTrustedWebRequest(req);
    try {
      const result = await this.authService.webRefresh(readRefreshCookie(req.headers.cookie));
      res.setHeader(
        'Set-Cookie',
        serializeRefreshCookie(result.refresh.token, result.refresh.maxAge),
      );
      return { accessToken: result.accessToken };
    } catch (error) {
      // A refused session is wiped from the browser too.
      res.setHeader('Set-Cookie', serializeClearedRefreshCookie());
      throw error;
    }
  }

  @Post('web/logout')
  @HttpCode(204)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  webLogout(
    @Req() req: ExpressRequest,
    @Res({ passthrough: true }) res: ExpressResponse,
  ): void {
    assertTrustedWebRequest(req);
    res.setHeader('Set-Cookie', serializeClearedRefreshCookie());
  }
}
