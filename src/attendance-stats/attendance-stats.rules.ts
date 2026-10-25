/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The attendance rules agreed for the mosque, in one place.
 *
 *   ثابت   REGULAR    missed at most `regularMaxMissed` required sessions in
 *                    the last `windowDays` days
 *   متذبذب IRREGULAR  attended some, missed more than that
 *   منقطع  INACTIVE   attended nothing in the last `windowDays` days —
 *                    left out of the "active students" number
 *   —      NO_DATA    their حلقة recorded no session in the window, so
 *                    nothing can be said about the student
 *
 * A session of a حلقة is a date on which at least one of its students has an
 * attendance record — whoever recorded it, the حلقة's own instructor or a
 * substitute. A student is measured only against sessions their حلقة held,
 * and only from the day they joined, so no student is penalised for an
 * instructor who did not record.
 *
 * LATE counts as attended. «غائب بعذر» (ABSENT + excused) is neutral: neither
 * attended nor missed. A required session with no record for the student
 * counts as missed in the window (the evening reminder exists so that this
 * does not happen), and is always reported separately as "unmarked".
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const ATTENDANCE_RULES = {
  /** The mosque's calendar. Syria is on permanent UTC+03:00. */
  localTimeZone: 'Asia/Damascus',
  /** Prisma writes DateTime as UTC into `timestamp(3)` columns. */
  storedTimeZone: 'UTC',
  windowDays: 28,
  regularMaxMissed: 1,
  /** "اتصل وطمّن عليه" once this many consecutive required sessions are unexcused ABSENT. */
  alertConsecutiveAbsences: 2,
} as const;

export type Classification = 'REGULAR' | 'IRREGULAR' | 'INACTIVE' | 'NO_DATA';

export const CLASSIFICATION_AR: Record<Classification, string> = {
  REGULAR: 'ثابت',
  IRREGULAR: 'متذبذب',
  INACTIVE: 'منقطع',
  NO_DATA: 'لا توجد جلسات مسجّلة',
};

export function classify(
  windowSessions: number,
  windowAttended: number,
): Classification {
  if (windowSessions <= 0) return 'NO_DATA';
  if (windowAttended <= 0) return 'INACTIVE';
  if (windowSessions - windowAttended <= ATTENDANCE_RULES.regularMaxMissed)
    return 'REGULAR';
  return 'IRREGULAR';
}
