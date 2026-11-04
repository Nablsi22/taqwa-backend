import { HttpException } from '@nestjs/common';
import { LoginAttemptsService } from './login-attempts.service';

/** The service with a clock the test moves by hand. */
class Clocked extends LoginAttemptsService {
  t = 1_000_000;
  protected override now(): number {
    return this.t;
  }
}

const MAX = LoginAttemptsService.MAX_FAILURES;
const fail = (s: LoginAttemptsService, user: string, times: number) => {
  for (let i = 0; i < times; i++) s.recordFailure(user);
};

describe('LoginAttemptsService', () => {
  it('lets wrong passwords through until the limit, then locks the account', () => {
    const s = new Clocked();
    fail(s, 'parent01', MAX - 1);
    expect(() => s.assertAllowed('parent01')).not.toThrow();
    s.recordFailure('parent01');
    expect(() => s.assertAllowed('parent01')).toThrow(HttpException);
  });

  it('answers 429 with the wait in Arabic', () => {
    const s = new Clocked();
    fail(s, 'parent01', MAX);
    let thrown: unknown;
    try {
      s.assertAllowed('parent01');
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(HttpException);
    const err = thrown as HttpException;
    expect(err.getStatus()).toBe(429);
    expect(JSON.stringify(err.getResponse())).toContain('10 دقائق');
  });

  it('treats the username without regard to case or spaces', () => {
    const s = new Clocked();
    fail(s, ' Parent01 ', MAX);
    expect(() => s.assertAllowed('parent01')).toThrow(HttpException);
  });

  it('unlocks by itself once the lock has run out', () => {
    const s = new Clocked();
    fail(s, 'parent01', MAX);
    s.t += LoginAttemptsService.LOCK_MS + 1;
    expect(() => s.assertAllowed('parent01')).not.toThrow();
  });

  it('forgets old failures outside the window', () => {
    const s = new Clocked();
    fail(s, 'parent01', MAX - 1);
    s.t += LoginAttemptsService.WINDOW_MS + 1;
    s.recordFailure('parent01');
    expect(() => s.assertAllowed('parent01')).not.toThrow();
  });

  it('clears the count on a correct password', () => {
    const s = new Clocked();
    fail(s, 'parent01', MAX - 1);
    s.recordSuccess('parent01');
    s.recordFailure('parent01');
    expect(() => s.assertAllowed('parent01')).not.toThrow();
  });

  it('does not let one account lock another', () => {
    const s = new Clocked();
    fail(s, 'parent01', MAX);
    expect(() => s.assertAllowed('parent02')).not.toThrow();
  });

  it('stays bounded under a flood of invented usernames', () => {
    const s = new Clocked();
    for (let i = 0; i < LoginAttemptsService.MAX_TRACKED + 500; i++) {
      s.recordFailure(`ghost${i}`);
    }
    expect(s.size).toBeLessThanOrEqual(LoginAttemptsService.MAX_TRACKED);
  });

  it('words the minutes correctly', () => {
    expect(LoginAttemptsService.minutesAr(1)).toBe('دقيقة واحدة');
    expect(LoginAttemptsService.minutesAr(2)).toBe('دقيقتين');
    expect(LoginAttemptsService.minutesAr(10)).toBe('10 دقائق');
    expect(LoginAttemptsService.minutesAr(15)).toBe('15 دقيقة');
  });
});
