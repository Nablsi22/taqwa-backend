/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Meeting-day calendar — pure functions, no I/O.
 *
 * A course (Term) declares its meeting days as ISO weekdays, the numbering of
 * PostgreSQL's EXTRACT(ISODOW): Monday = 1 … Sunday = 7.
 *
 *   REQUIRED  a day every student is expected at. Only a required day can be
 *             missed, and only a required-day absence is ever deducted.
 *   OPTIONAL  e.g. winter Thursday, for students who memorise. It counts for
 *             a student only if they attended — "نكافئ يلي بيجي وما نخصم من
 *             يلي بيغيب".
 *   EXTRA     any other day (a make-up session, or a record entered late on
 *             the wrong day). Treated exactly like OPTIONAL.
 *
 * Calendar days are plain 'YYYY-MM-DD' strings in the mosque's time zone and
 * are handled with UTC arithmetic only, so no server or device time zone can
 * shift a day.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type IsoDow = 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type DayKind = 'REQUIRED' | 'OPTIONAL' | 'EXTRA';

export interface MeetingDays {
  required: IsoDow[];
  optional: IsoDow[];
  /** 'COURSE' = configured on the course; 'INFERRED' = derived from recorded sessions. */
  source: 'COURSE' | 'INFERRED';
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isCalendarDay(value: string): boolean {
  if (!DAY_RE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isIsoDow(n: unknown): n is IsoDow {
  return Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 7;
}

/** ISO weekday of a calendar day. */
export function isoDow(day: string): IsoDow {
  const js = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return (js === 0 ? 7 : js) as IsoDow;
}

/** `day` plus `delta` calendar days. */
export function addDays(day: string, delta: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** A JS Date (or a Prisma `@db.Date` value, which arrives as UTC midnight) as 'YYYY-MM-DD'. */
export function toCalendarDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Today's calendar day in `timeZone` (IANA), e.g. 'Asia/Damascus'. */
export function localToday(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function dayKindOf(
  day: string,
  days: { required: readonly IsoDow[]; optional: readonly IsoDow[] },
): DayKind {
  const dow = isoDow(day);
  if (days.required.includes(dow)) return 'REQUIRED';
  if (days.optional.includes(dow)) return 'OPTIONAL';
  return 'EXTRA';
}

/**
 * Meeting days of a course: as configured, or — for a course nobody has
 * configured — the weekdays holding at least 10 % of its recorded session
 * days, all treated as required.
 */
export function resolveMeetingDays(
  configured: { requiredDays: number[]; optionalDays: number[] },
  observed: { isodow: number; days: number }[],
): MeetingDays {
  const required = [...new Set(configured.requiredDays.filter(isIsoDow))].sort(
    (a, b) => a - b,
  );
  const optional = [...new Set(configured.optionalDays.filter(isIsoDow))]
    .filter((d) => !required.includes(d))
    .sort((a, b) => a - b);
  if (required.length > 0 || optional.length > 0)
    return { required, optional, source: 'COURSE' };

  const total = observed.reduce((s, r) => s + r.days, 0);
  const inferred = observed
    .filter((r) => isIsoDow(r.isodow) && total > 0 && r.days / total >= 0.1)
    .map((r) => r.isodow as IsoDow)
    .sort((a, b) => a - b);
  return { required: inferred, optional: [], source: 'INFERRED' };
}

/**
 * «آخر يوم دوام»: the most recent day of `kinds` on or before `today`, not
 * before `courseStart`. Today itself counts only once at least one attendance
 * record exists for it — someone opening the app at 10 am on a Saturday must
 * not read a day that has not happened yet as "nobody came".
 *
 *   scheduled    the last such day by the calendar, recorded or not
 *   withRecords  the last such day that actually has attendance records
 */
export function lastSessionDay(
  today: string,
  courseStart: string,
  weekdays: readonly IsoDow[],
  recordedDays: ReadonlySet<string>,
  /** Upper bound on the walk back — a course ends, a calendar does not. */
  courseEnd: string | null = null,
): { scheduled: string | null; withRecords: string | null } {
  let scheduled: string | null = null;
  let withRecords: string | null = null;
  if (weekdays.length === 0) return { scheduled, withRecords };
  const from = courseEnd && courseEnd < today ? courseEnd : today;
  for (let d = from; d >= courseStart; d = addDays(d, -1)) {
    if (!weekdays.includes(isoDow(d))) continue;
    if (d === today && !recordedDays.has(d)) continue;
    scheduled ??= d;
    if (recordedDays.has(d)) {
      withRecords = d;
      break;
    }
  }
  return { scheduled, withRecords };
}

/** First and last calendar day of a 'YYYY-MM' month. */
export function monthBounds(month: string): { first: string; last: string } {
  const [y, m] = month.split('-').map(Number);
  const first = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); // day 0 of next month
  return { first, last };
}

export function isMonth(value: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}
