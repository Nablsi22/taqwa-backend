import {
  DayKind,
  IsoDow,
  addDays,
  isoDow,
} from '../attendance-stats/meeting-days';

/** One scheduled day of a course, by the calendar alone. */
export interface ScheduledDay {
  date: string;
  kind: Exclude<DayKind, 'EXTRA'>;
}

/**
 * Every meeting day of a course between [from] and [to], inclusive, oldest
 * first — the calendar an instructor was expected to record on.
 *
 * This is the opposite of a "session" in attendance-stats, which is a day
 * that HAS records. The director's question is about days that should have
 * records, so a حلقة nobody recorded still has rows here. That is the whole
 * point: an instructor who never records would otherwise simply be absent
 * from the data.
 *
 * Winter 2026-27 → required Saturday, optional Thursday. Summer → Saturday,
 * Monday, Wednesday, all required. A course with no meeting days configured
 * returns nothing: with no schedule there is no day anybody was due to
 * record, and reporting every calendar day as missed would be false.
 */
export function scheduledDays(
  from: string,
  to: string,
  days: { required: readonly IsoDow[]; optional: readonly IsoDow[] },
): ScheduledDay[] {
  if (from > to) return [];
  if (days.required.length === 0 && days.optional.length === 0) return [];
  const out: ScheduledDay[] = [];
  // A course runs for months, not years; a day-by-day walk is clearer than
  // date arithmetic and cheap enough at this size.
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = isoDow(d);
    if (days.required.includes(dow)) out.push({ date: d, kind: 'REQUIRED' });
    else if (days.optional.includes(dow)) out.push({ date: d, kind: 'OPTIONAL' });
  }
  return out;
}

/**
 * The last [count] REQUIRED days on or before [to] — «آخر 4 جلسات», the strip
 * on the director's main screen. Oldest first, so the strip reads right to
 * left in Arabic with the newest at the end.
 *
 * Optional days are left out on purpose: nobody is counted absent on a
 * Thursday, so not recording one is not a failure to record a session.
 */
export function lastRequiredDays(
  from: string,
  to: string,
  days: { required: readonly IsoDow[]; optional: readonly IsoDow[] },
  count: number,
): string[] {
  const all = scheduledDays(from, to, days)
    .filter((d) => d.kind === 'REQUIRED')
    .map((d) => d.date);
  return count > 0 && all.length > count ? all.slice(all.length - count) : all;
}
