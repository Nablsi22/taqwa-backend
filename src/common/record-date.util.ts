/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Record dates — «تاريخ التسجيل» for writes that have no calendar-date column.
 *
 * `points_log` and `hadith_recitations` carry only `created_at`. When an
 * instructor records something for an earlier day (the same way a recitation
 * already can be), the row is stamped with that day at the current wall-clock
 * time of the mosque's time zone, so:
 *   • it sorts and groups under the chosen day in every history screen, and
 *   • several entries made for the same past day keep their real order.
 *
 * Pure functions, no I/O. Calendar days are plain 'YYYY-MM-DD' strings.
 *
 * Refs:
 *   Intl.DateTimeFormat#formatToParts —
 *     https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/DateTimeFormat/formatToParts
 *   Date.UTC — https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Date/UTC
 * ═══════════════════════════════════════════════════════════════════════════
 */

const CALENDAR_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export interface CalendarDay {
  year: number;
  month: number; // 1–12
  day: number; // 1–31
}

/** 'YYYY-MM-DD' → its parts, or null when it is not a real calendar day. */
export function parseCalendarDay(value: string): CalendarDay | null {
  const match = CALENDAR_DAY.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  // Round-trip through Date.UTC so '2026-02-30' is rejected, not rolled over.
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/** Milliseconds `timeZone` is ahead of UTC at the instant `at`. */
export function timeZoneOffsetMs(at: Date, timeZone: string): number {
  const fields: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at)) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  const wallClockAsUtc = Date.UTC(
    fields.year,
    fields.month - 1,
    fields.day,
    fields.hour,
    fields.minute,
    fields.second,
  );
  const atWholeSecond = Math.floor(at.getTime() / 1000) * 1000;
  return wallClockAsUtc - atWholeSecond;
}

/**
 * The instant that reads as «`day`, at the current time of day» in `timeZone`.
 *
 * e.g. day '2026-10-24', now 2026-10-30 14:05:09 Damascus (+03:00)
 *   → 2026-10-24T11:05:09Z  (= 2026-10-24 14:05:09 in Damascus)
 *
 * Throws on a malformed day; callers validate first and turn that into a
 * user-facing message.
 */
export function composeRecordTimestamp(
  day: string,
  timeZone: string,
  now: Date = new Date(),
): Date {
  const parsed = parseCalendarDay(day);
  if (!parsed) throw new Error(`Invalid calendar day: ${day}`);

  const nowOffset = timeZoneOffsetMs(now, timeZone);
  const wallNow = new Date(now.getTime() + nowOffset);
  const wallTarget = Date.UTC(
    parsed.year,
    parsed.month - 1,
    parsed.day,
    wallNow.getUTCHours(),
    wallNow.getUTCMinutes(),
    wallNow.getUTCSeconds(),
    wallNow.getUTCMilliseconds(),
  );

  // Re-read the offset at the target instant so a zone with daylight saving
  // still lands on the requested wall-clock time.
  const firstGuess = new Date(wallTarget - nowOffset);
  return new Date(wallTarget - timeZoneOffsetMs(firstGuess, timeZone));
}
