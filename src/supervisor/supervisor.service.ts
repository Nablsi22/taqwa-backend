import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  AttendanceStatsService,
  CourseContext,
} from '../attendance-stats/attendance-stats.service';
import { ATTENDANCE_RULES } from '../attendance-stats/attendance-stats.rules';
import { addDays, isCalendarDay } from '../attendance-stats/meeting-days';
import { DisciplineRow, RECORDING_DISCIPLINE_SQL } from './supervisor.sql';
import { ScheduledDay, lastRequiredDays, scheduledDays } from './meeting-calendar';

/** How a حلقة's single meeting day went, from the director's side. */
export interface SessionRecord {
  date: string;
  kind: 'REQUIRED' | 'OPTIONAL';
  recorded: boolean;
  /** Local 'YYYY-MM-DDTHH:MM' of the first mark saved that day. */
  recordedAt: string | null;
  /** 0 = same day, 1 = next day, … null when never recorded. */
  lagDays: number | null;
  markedByName: string | null;
  /** Recorded by a substitute (or an admin), not by the حلقة's own أستاذ. */
  byOther: boolean;
  marks: number;
  /**
   * A required day with nothing recorded and nobody covering — the only
   * case the director should hold the أستاذ to.
   */
  missed: boolean;
}

export interface InstructorDiscipline {
  instructorId: string;
  instructorName: string;
  students: number;
  /** Oldest first. */
  sessions: SessionRecord[];
  requiredCount: number;
  recordedCount: number;
  /** Required days with nothing recorded and no substitute. */
  missedCount: number;
  /** Required days somebody else recorded for him. */
  coveredCount: number;
  sameDayCount: number;
  lateCount: number;
  /** Mean lag over the days he recorded himself; null if he recorded none. */
  avgLagDays: number | null;
  lastRecorded: { date: string; recordedAt: string | null; lagDays: number | null } | null;
  neverRecorded: boolean;
}

@Injectable()
export class SupervisorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: AttendanceStatsService,
  ) {}

  /** The course being looked at, with its meeting days. */
  courseContext(termId?: number): Promise<CourseContext> {
    return this.stats.courseContext(termId);
  }

  /**
   * The last day an أستاذ can be judged on. Recording any time before
   * midnight counts as on time, so today is never over yet: a director
   * opening the app at 10 am on a Saturday must not see every حلقة marked
   * "did not record" for a session that has not happened. Today's recording
   * is visible on the day screen meanwhile.
   */
  static judgedUntil(ctx: CourseContext): string {
    const yesterday = addDays(ctx.today, -1);
    return ctx.measuredUntil < yesterday ? ctx.measuredUntil : yesterday;
  }

  private async discipline(
    days: ScheduledDay[],
  ): Promise<Map<string, { name: string; students: number; rows: DisciplineRow[] }>> {
    const byInstructor = new Map<
      string,
      { name: string; students: number; rows: DisciplineRow[] }
    >();
    if (days.length === 0) return byInstructor;

    const dates = days.map((d) => d.date);
    const rows = await this.prisma.$queryRawUnsafe<DisciplineRow[]>(
      RECORDING_DISCIPLINE_SQL,
      dates[0],
      dates[dates.length - 1],
      `{${dates.join(',')}}`,
      ATTENDANCE_RULES.localTimeZone,
      ATTENDANCE_RULES.storedTimeZone,
    );
    for (const r of rows) {
      let entry = byInstructor.get(r.instructor_id);
      if (!entry) {
        entry = { name: r.instructor_name, students: r.students, rows: [] };
        byInstructor.set(r.instructor_id, entry);
      }
      entry.rows.push(r);
    }
    return byInstructor;
  }

  private summarise(
    instructorId: string,
    entry: { name: string; students: number; rows: DisciplineRow[] },
    kindOf: Map<string, 'REQUIRED' | 'OPTIONAL'>,
  ): InstructorDiscipline {
    const sessions: SessionRecord[] = entry.rows.map((r) => {
      const kind = kindOf.get(r.date) ?? 'REQUIRED';
      return {
        date: r.date,
        kind,
        recorded: r.recorded,
        recordedAt: r.recorded_at,
        lagDays: r.lag_days,
        markedByName: r.marked_by_name,
        byOther: r.by_other,
        marks: r.marks,
        // An optional day costs nobody points, so not recording one is not a
        // failure to record a session. A day a substitute recorded is not
        // held against the أستاذ either.
        missed: kind === 'REQUIRED' && !r.recorded,
      };
    });

    const required = sessions.filter((s) => s.kind === 'REQUIRED');
    const own = required.filter((s) => s.recorded && !s.byOther);
    const lags = own
      .map((s) => s.lagDays)
      .filter((n): n is number => n !== null);
    const lastRec = [...sessions].reverse().find((s) => s.recorded) ?? null;

    return {
      instructorId,
      instructorName: entry.name,
      students: entry.students,
      sessions,
      requiredCount: required.length,
      recordedCount: required.filter((s) => s.recorded).length,
      missedCount: required.filter((s) => s.missed).length,
      coveredCount: required.filter((s) => s.recorded && s.byOther).length,
      sameDayCount: own.filter((s) => s.lagDays === 0).length,
      lateCount: own.filter((s) => (s.lagDays ?? 0) > 0).length,
      avgLagDays:
        lags.length === 0
          ? null
          : Math.round((lags.reduce((a, b) => a + b, 0) / lags.length) * 10) / 10,
      lastRecorded: lastRec
        ? {
            date: lastRec.date,
            recordedAt: lastRec.recordedAt,
            lagDays: lastRec.lagDays,
          }
        : null,
      neverRecorded: sessions.every((s) => !s.recorded),
    };
  }

  /**
   * Worst first: most missed required days, then slowest to record, then by
   * name. The order is the oversight — the director never sorts or filters,
   * so whoever needs following up is already at the top of his screen.
   */
  private static worstFirst(
    a: InstructorDiscipline,
    b: InstructorDiscipline,
  ): number {
    if (a.missedCount !== b.missedCount) return b.missedCount - a.missedCount;
    const al = a.avgLagDays ?? -1;
    const bl = b.avgLagDays ?? -1;
    if (al !== bl) return bl - al;
    return a.instructorName.localeCompare(b.instructorName, 'ar');
  }

  // ───────────────────────────────────────────────────────────────────────
  // The main screen: recording discipline over the last N required sessions
  // ───────────────────────────────────────────────────────────────────────

  async instructors(termId?: number, sessionCount = 4) {
    const ctx = await this.courseContext(termId);
    const dates = lastRequiredDays(
      ctx.term.startDate,
      SupervisorService.judgedUntil(ctx),
      ctx.meetingDays,
      sessionCount,
    );
    const days: ScheduledDay[] = dates.map((date) => ({ date, kind: 'REQUIRED' }));
    const kindOf = new Map(days.map((d) => [d.date, d.kind]));
    const byInstructor = await this.discipline(days);

    const data = [...byInstructor.entries()]
      .map(([id, entry]) => this.summarise(id, entry, kindOf))
      .sort(SupervisorService.worstFirst);

    const lastSession = dates.length ? dates[dates.length - 1] : null;
    const onLast = lastSession
      ? data.map((d) => d.sessions.find((s) => s.date === lastSession))
      : [];
    const lagsOnLast = onLast
      .filter((s) => s?.recorded)
      .map((s) => s!.lagDays)
      .filter((n): n is number => n !== null);

    return {
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      days: dates,
      lastSession,
      summary: {
        halaqas: data.length,
        recorded: onLast.filter((s) => s?.recorded).length,
        notRecorded: onLast.filter((s) => s && !s.recorded).length,
        covered: onLast.filter((s) => s?.recorded && s.byOther).length,
        sameDay: lagsOnLast.filter((n) => n === 0).length,
        late: lagsOnLast.filter((n) => n > 0).length,
        neverRecorded: data.filter((d) => d.neverRecorded).length,
      },
      data,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // One أستاذ: every meeting day of the course, and his students
  // ───────────────────────────────────────────────────────────────────────

  async instructor(instructorId: string, termId?: number) {
    const ctx = await this.courseContext(termId);
    const days = scheduledDays(
      ctx.term.startDate,
      SupervisorService.judgedUntil(ctx),
      ctx.meetingDays,
    );
    const kindOf = new Map(days.map((d) => [d.date, d.kind]));
    const byInstructor = await this.discipline(days);
    const entry = byInstructor.get(instructorId);

    const students = await this.stats.studentStats(ctx, { instructorId });
    const summary = entry
      ? this.summarise(instructorId, entry, kindOf)
      : null;

    return {
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      windowStart: ctx.windowStart,
      // Newest first here: reading his record starts from the last session.
      discipline: summary
        ? { ...summary, sessions: [...summary.sessions].reverse() }
        : null,
      students,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // One day across every حلقة, with the time each one was recorded
  // ───────────────────────────────────────────────────────────────────────

  async day(date: string | undefined, termId?: number) {
    const ctx = await this.courseContext(termId);
    const day = date ?? ctx.lastRequired.withRecords;
    if (!day) {
      return {
        course: { ...ctx.term, meetingDays: ctx.meetingDays },
        date: null,
        kind: null,
        halaqas: [],
        message: 'لا توجد جلسة مسجّلة في هذه الدورة بعد',
      };
    }
    if (!isCalendarDay(day)) throw new BadRequestException('تاريخ غير صالح');
    this.stats.assertDayInCourse(ctx, day);

    const [session, recording] = await Promise.all([
      this.stats.day(ctx, day, null),
      this.discipline([{ date: day, kind: 'REQUIRED' }]),
    ]);

    // Every حلقة of the course, recorded or not, with when it was recorded.
    const halaqas = [...recording.entries()]
      .map(([id, entry]) => {
        const row = entry.rows[0];
        const fromStats = session.halaqas.find((h) => h.instructorId === id);
        return {
          instructorId: id,
          instructorName: entry.name,
          students: entry.students,
          recorded: row?.recorded ?? false,
          recordedAt: row?.recorded_at ?? null,
          lagDays: row?.lag_days ?? null,
          markedByName: row?.marked_by_name ?? null,
          byOther: row?.by_other ?? false,
          present: fromStats?.present ?? 0,
          late: fromStats?.late ?? 0,
          absent: fromStats?.absent ?? 0,
          excused: fromStats?.excused ?? 0,
          unmarked: fromStats?.unmarked ?? entry.students,
          coveredBy: fromStats?.coveredBy ?? [],
          roster: fromStats?.roster ?? [],
        };
      })
      .sort((a, b) => {
        if (a.recorded !== b.recorded) return a.recorded ? 1 : -1;
        return a.instructorName.localeCompare(b.instructorName, 'ar');
      });

    return {
      // With its meeting days, so the app can step to the previous or next
      // Saturday / Thursday (or, in summer, Saturday / Monday / Wednesday).
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      date: day,
      kind: session.kind,
      halaqas,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Students, and the course overview — the existing read-only statistics
  // ───────────────────────────────────────────────────────────────────────

  async students(termId?: number) {
    const ctx = await this.courseContext(termId);
    return {
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      windowStart: ctx.windowStart,
      measuredUntil: ctx.measuredUntil,
      data: await this.stats.studentStats(ctx),
    };
  }

  overview(termId?: number) {
    return this.stats.overview(termId);
  }
}
