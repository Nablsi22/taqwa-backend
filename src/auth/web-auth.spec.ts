import { INestApplication, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginAttemptsService } from './login-attempts.service';
import { WEB_REFRESH_COOKIE, WEB_TOKEN_AUDIENCE } from './web-session';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

const ENV: Record<string, string> = {
  JWT_SECRET: 'test-access-secret-0123456789abcdef',
  JWT_REFRESH_SECRET: 'test-refresh-secret-0123456789abcdef',
  JWT_ACCESS_TTL: '15m',
  JWT_REFRESH_TTL: '180d',
};

const PASSWORD = 'correct-horse';

function makeUser(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'u-1',
    username: 'parent1',
    role: 'STUDENT',
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    isActive: true,
    deletedAt: null,
    student: {
      id: 's-1',
      fullName: 'طالب',
      fatherName: 'أب',
      instructorId: 'i-1',
    },
    instructor: null,
    ...overrides,
  };
}

function makeService(user = makeUser()) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue(user),
      update: jest.fn().mockResolvedValue(user),
    },
  };
  const config = { get: (key: string) => ENV[key] } as unknown as ConfigService;
  const jwt = new JwtService();
  const service = new AuthService(
    prisma as unknown as PrismaService,
    jwt,
    config,
    new LoginAttemptsService(),
  );
  return { service, jwt, prisma };
}

describe('AuthService — web session', () => {
  afterEach(() => jest.useRealTimers());

  it('issues a web refresh token with aud, typ and session start', async () => {
    const { service, jwt } = makeService();
    const result = await service.webLogin({
      username: 'parent1',
      password: PASSWORD,
    });
    const claims = jwt.verify<Record<string, unknown>>(result.refresh.token, {
      secret: ENV.JWT_REFRESH_SECRET,
      audience: WEB_TOKEN_AUDIENCE,
    });
    expect(claims).toMatchObject({
      sub: 'u-1',
      typ: 'refresh',
      aud: WEB_TOKEN_AUDIENCE,
    });
    expect(typeof claims.ses).toBe('number');
    expect(typeof claims.jti).toBe('string');
    expect(result.refresh.maxAge).toBe(14 * 86_400);
    expect(result).not.toHaveProperty('refreshToken');
  });

  it('rotates the token on refresh and keeps the session start', async () => {
    const { service, jwt } = makeService();
    const login = await service.webLogin({
      username: 'parent1',
      password: PASSWORD,
    });
    const refreshed = await service.webRefresh(login.refresh.token);
    expect(refreshed.refresh.token).not.toBe(login.refresh.token);
    const before = jwt.decode<Record<string, unknown>>(login.refresh.token);
    const after = jwt.decode<Record<string, unknown>>(refreshed.refresh.token);
    expect(after.ses).toBe(before.ses);
    expect(
      jwt.verify<{ sub: string }>(refreshed.accessToken, {
        secret: ENV.JWT_SECRET,
      }).sub,
    ).toBe('u-1');
  });

  it('ends a session after the absolute lifetime however often it is refreshed', async () => {
    jest.useFakeTimers({ now: new Date('2026-11-01T00:00:00Z') });
    const { service } = makeService();
    let token = (
      await service.webLogin({ username: 'parent1', password: PASSWORD })
    ).refresh.token;
    for (let day = 1; day <= 29; day += 1) {
      jest.setSystemTime(new Date(Date.UTC(2026, 10, 1 + day)));
      const result = await service.webRefresh(token);
      token = result.refresh.token;
      // The cookie never outlives the session's end.
      expect(result.refresh.maxAge).toBeLessThanOrEqual((30 - day) * 86_400);
    }
    jest.setSystemTime(new Date(Date.UTC(2026, 11, 1, 0, 0, 1)));
    await expect(service.webRefresh(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses a phone refresh token on the web endpoint', async () => {
    const { service } = makeService();
    const phone = await service.login({
      username: 'parent1',
      password: PASSWORD,
    });
    await expect(service.webRefresh(phone.refreshToken)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('refuses a web refresh token on the phone endpoint', async () => {
    const { service } = makeService();
    const web = await service.webLogin({
      username: 'parent1',
      password: PASSWORD,
    });
    await expect(
      service.refreshToken(web.refresh.token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses access tokens, forged and future-dated tokens', async () => {
    const { service, jwt } = makeService();
    const login = await service.webLogin({
      username: 'parent1',
      password: PASSWORD,
    });
    const forged = jwt.sign(
      { sub: 'u-1', typ: 'refresh', ses: Math.floor(Date.now() / 1000) },
      {
        secret: 'not-the-secret',
        audience: WEB_TOKEN_AUDIENCE,
        expiresIn: 600,
      },
    );
    const future = jwt.sign(
      {
        sub: 'u-1',
        typ: 'refresh',
        ses: Math.floor(Date.now() / 1000) + 86_400,
      },
      {
        secret: ENV.JWT_REFRESH_SECRET,
        audience: WEB_TOKEN_AUDIENCE,
        expiresIn: 600,
      },
    );
    const access = jwt.sign(
      { sub: 'u-1', typ: 'access', ses: 1 },
      {
        secret: ENV.JWT_REFRESH_SECRET,
        audience: WEB_TOKEN_AUDIENCE,
        expiresIn: 600,
      },
    );
    for (const token of [
      login.accessToken,
      forged,
      future,
      access,
      undefined,
      '',
    ]) {
      await expect(service.webRefresh(token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    }
  });

  it('refuses a deactivated or deleted account', async () => {
    const { service, prisma } = makeService();
    const login = await service.webLogin({
      username: 'parent1',
      password: PASSWORD,
    });
    prisma.user.findUnique.mockResolvedValueOnce(makeUser({ isActive: false }));
    await expect(
      service.webRefresh(login.refresh.token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    prisma.user.findUnique.mockResolvedValueOnce(
      makeUser({ deletedAt: new Date() }),
    );
    await expect(
      service.webRefresh(login.refresh.token),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('keeps the phone login unchanged', async () => {
    const { service, jwt } = makeService();
    const phone = await service.login({
      username: 'parent1',
      password: PASSWORD,
    });
    expect(phone.refreshToken).toBeDefined();
    expect(
      jwt.decode<Record<string, unknown>>(phone.refreshToken).aud,
    ).toBeUndefined();
    const refreshed = await service.refreshToken(phone.refreshToken);
    expect(refreshed.accessToken).toBeDefined();
  });
});

describe('AuthController — web endpoints over HTTP', () => {
  let app: INestApplication;
  const auth = {
    webLogin: jest.fn(),
    webRefresh: jest.fn(),
  };
  const JWT = 'aaa.bbb.ccc';
  const webHeaders = {
    'X-Taqwa-Client': 'web',
    'Sec-Fetch-Site': 'same-origin',
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [{ provide: AuthService, useValue: auth }],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(() => app.close());
  beforeEach(() => jest.resetAllMocks());

  it('login: sets the HttpOnly cookie and never returns the refresh token', async () => {
    auth.webLogin.mockResolvedValue({
      accessToken: 'access',
      user: { id: 'u-1' },
      refresh: { token: JWT, maxAge: 600 },
    });
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/web/login')
      .set(webHeaders)
      .send({ username: 'parent1', password: PASSWORD })
      .expect(200);
    expect(res.body).toEqual({ accessToken: 'access', user: { id: 'u-1' } });
    expect(JSON.stringify(res.body)).not.toContain(JWT);
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain(`${WEB_REFRESH_COOKIE}=${JWT}`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('login: refuses a cross-site request before checking the password', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/auth/web/login')
      .set({ 'Sec-Fetch-Site': 'cross-site', 'X-Taqwa-Client': 'web' })
      .send({ username: 'parent1', password: PASSWORD })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/auth/web/login')
      .send({ username: 'parent1', password: PASSWORD })
      .expect(403);
    expect(auth.webLogin).not.toHaveBeenCalled();
  });

  it('refresh: reads the cookie, rotates it, returns only the access token', async () => {
    auth.webRefresh.mockResolvedValue({
      accessToken: 'new-access',
      refresh: { token: 'x.y.z', maxAge: 60 },
    });
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/web/refresh')
      .set(webHeaders)
      .set('Cookie', `${WEB_REFRESH_COOKIE}=${JWT}`)
      .expect(200);
    expect(auth.webRefresh).toHaveBeenCalledWith(JWT);
    expect(res.body).toEqual({ accessToken: 'new-access' });
    expect(String(res.headers['set-cookie'])).toContain(
      `${WEB_REFRESH_COOKIE}=x.y.z`,
    );
  });

  it('refresh: clears the cookie when the session is refused', async () => {
    auth.webRefresh.mockRejectedValue(new UnauthorizedException());
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/web/refresh')
      .set(webHeaders)
      .set('Cookie', `${WEB_REFRESH_COOKIE}=${JWT}`)
      .expect(401);
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
  });

  it('logout: clears the cookie (204)', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/auth/web/logout')
      .set(webHeaders)
      .expect(204);
    expect(String(res.headers['set-cookie'])).toContain(
      `${WEB_REFRESH_COOKIE}=; Max-Age=0`,
    );
  });
});
