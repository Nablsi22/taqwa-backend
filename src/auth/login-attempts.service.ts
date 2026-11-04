import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A brake on guessing passwords, per account.
 *
 * After [MAX_FAILURES] wrong passwords for one username within [WINDOW_MS],
 * that username cannot sign in for [LOCK_MS] — whoever asks and from
 * wherever, so changing phone or network does not reset it. A correct
 * password clears the count. The message says how long to wait.
 *
 * Kept in memory: the API runs as a single Railway instance, and a restart
 * merely forgives everyone. The map is bounded, so a flood of invented
 * usernames cannot grow it without limit.
 *
 * Ref: OWASP Authentication Cheat Sheet — "Protect against automated attacks"
 *      https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html
 * ═══════════════════════════════════════════════════════════════════════════
 */
interface Attempts {
  failures: number;
  firstFailureAt: number;
  lockedUntil: number;
}

@Injectable()
export class LoginAttemptsService {
  static readonly MAX_FAILURES = 8;
  static readonly WINDOW_MS = 15 * 60_000;
  static readonly LOCK_MS = 10 * 60_000;
  static readonly MAX_TRACKED = 10_000;

  private readonly attempts = new Map<string, Attempts>();

  /** Overridden in tests. */
  protected now(): number {
    return Date.now();
  }

  /** Throws 429 while [username] is locked. */
  assertAllowed(username: string): void {
    const entry = this.attempts.get(LoginAttemptsService.key(username));
    if (!entry) return;
    const left = entry.lockedUntil - this.now();
    if (left <= 0) return;
    const minutes = Math.ceil(left / 60_000);
    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message:
          'أُوقف تسجيل الدخول لهذا الحساب مؤقتاً بعد محاولات خاطئة متكررة. ' +
          `حاول مرة أخرى بعد ${LoginAttemptsService.minutesAr(minutes)}.`,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  recordFailure(username: string): void {
    const key = LoginAttemptsService.key(username);
    const now = this.now();
    let entry = this.attempts.get(key);
    if (!entry || now - entry.firstFailureAt > LoginAttemptsService.WINDOW_MS) {
      entry = { failures: 0, firstFailureAt: now, lockedUntil: 0 };
    }
    entry.failures += 1;
    if (entry.failures >= LoginAttemptsService.MAX_FAILURES) {
      entry.lockedUntil = now + LoginAttemptsService.LOCK_MS;
      entry.failures = 0;
      entry.firstFailureAt = now;
    }
    // Re-inserted so the map's order stays oldest-first for pruning.
    this.attempts.delete(key);
    this.attempts.set(key, entry);
    this.prune(now);
  }

  recordSuccess(username: string): void {
    this.attempts.delete(LoginAttemptsService.key(username));
  }

  /** How many usernames are being tracked (tests, diagnostics). */
  get size(): number {
    return this.attempts.size;
  }

  private prune(now: number): void {
    if (this.attempts.size <= LoginAttemptsService.MAX_TRACKED) return;
    for (const [key, entry] of this.attempts) {
      const stale =
        entry.lockedUntil <= now &&
        now - entry.firstFailureAt > LoginAttemptsService.WINDOW_MS;
      if (stale) this.attempts.delete(key);
    }
    // Still too many: drop the oldest.
    for (const key of this.attempts.keys()) {
      if (this.attempts.size <= LoginAttemptsService.MAX_TRACKED) break;
      this.attempts.delete(key);
    }
  }

  private static key(username: string): string {
    return (username ?? '').trim().toLowerCase();
  }

  /** «دقيقة واحدة» · «دقيقتين» · «3 دقائق» · «11 دقيقة». */
  static minutesAr(n: number): string {
    if (n <= 1) return 'دقيقة واحدة';
    if (n === 2) return 'دقيقتين';
    if (n <= 10) return `${n} دقائق`;
    return `${n} دقيقة`;
  }
}
