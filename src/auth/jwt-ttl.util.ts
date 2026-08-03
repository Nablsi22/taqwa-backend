import type { JwtSignOptions } from '@nestjs/jwt';

/**
 * النوع الذي يقبله @nestjs/jwt في expiresIn.
 * مشتقّ من المكتبة نفسها بدل الاعتماد على حزمة ms مباشرةً،
 * فيبقى صحيحاً عبر ترقيات المكتبة.
 */
export type JwtTtl = NonNullable<JwtSignOptions['expiresIn']>;

const TTL_PATTERN =
  /^\d+(\.\d+)?\s*(milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;

/**
 * يتحقّق من صيغة مدة الصلاحية قبل تمريرها إلى jsonwebtoken.
 * الفشل هنا صريح ومفهوم، بدل سلوك غامض عند التوقيع.
 */
export function resolveTtl(value: string | undefined, fallback: string): JwtTtl {
  const candidate = (value ?? '').trim() || fallback;

  if (!TTL_PATTERN.test(candidate)) {
    throw new Error(
      `Invalid JWT TTL "${candidate}". Expected a duration such as "15m" or "180d".`,
    );
  }

  return candidate as JwtTtl;
}