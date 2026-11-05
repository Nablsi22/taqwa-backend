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
const UNIT_SECONDS: ReadonlyArray<[RegExp, number]> = [
  [/^(milliseconds?|msecs?|ms)$/i, 0.001],
  [/^(seconds?|secs?|s)$/i, 1],
  [/^(minutes?|mins?|m)$/i, 60],
  [/^(hours?|hrs?|h)$/i, 3600],
  [/^(days?|d)$/i, 86_400],
  [/^(weeks?|w)$/i, 604_800],
  [/^(years?|yrs?|y)$/i, 31_557_600], // 365.25 days, as the `ms` package
];

/**
 * المدة بالثواني (مثلاً لـ Max-Age في الكوكي). الرقم المجرّد ثوانٍ، كما في
 * jsonwebtoken. يرمي خطأً للصيغة غير الصالحة، تماماً مثل resolveTtl.
 */
export function ttlToSeconds(value: string | undefined, fallback: string): number {
  const ttl = String(resolveTtl(value, fallback)).trim();
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(ttl);
  if (!match) throw new Error(`Invalid JWT TTL "${ttl}"`);
  const amount = Number(match[1]);
  const unit = match[2];
  if (!unit) return Math.floor(amount);
  const factor = UNIT_SECONDS.find(([pattern]) => pattern.test(unit))?.[1];
  if (factor === undefined) throw new Error(`Invalid JWT TTL unit "${unit}"`);
  return Math.floor(amount * factor);
}
