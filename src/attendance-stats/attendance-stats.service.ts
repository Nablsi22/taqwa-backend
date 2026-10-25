import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  DayKind,
  IsoDow,
  MeetingDays,
  addDays,
  dayKindOf,
  isoDow,
  lastSessionDay,
  localToday,
  monthBounds,
  resolveMeetingDays,
  toCalendarDay,
} from './meeting-days';
import {
  ATTENDANCE_RULES,
  Classification,
  classify,
} from './attendance-stats.rules';
import {
  DAY_ROSTER_SQL,
  HOLDING_COUNT_SQL,
  RECORDED_DAYS_SQL,
  STUDENT_SUMMARY_SQL,
  WEEKDAY_SPREAD_SQL,
} from './attendance-stats.sql';

// ═══════════════════════════════════════════════════════════════════════════
// Row shapes returned by the SQL (all casts are in the SQL itself)
// ═══════════════════════════════════════════════════════════════════════════

interface StudentSummaryRow {
  student_id: string;
  full_name: string;
  father_name: string;
  instructor_id: string;
  instructor_name: string;
  school: string | null;
  grade: string | null;
  joined: string;
  sessions: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  unmarked: number;
  win_sessions: number;
  win_attended: number;
  absent_streak: number;
  last_attended: string | null;
  last_session: string | null;
}

interface DayRosterRow {
  student_id: string;
  full_name: string;
  father_name: string;
  instructor_id: string;
  instructor_name: string;
  status: 'PRESENT' | 'LATE' | 'ABSENT' | null;
  excused: boolean;
  by_other: boolean;
  marker_role: string | null;
  marked_by_name: string | null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public result shapes
// ═══════════════════════════════════════════════════════════════════════════

export interface CourseContext {
  term: {
    id: number;
    name: string;
    nameAr: string;
    startDate: string;
    endDate: string | null;
    isActive: boolean;
  };
  meetingDays: MeetingDays;
  today: string;
  /** Last day measured: the course end, or today for an open course. */
  measuredUntil: string;
  windowStart: string;
  lastRequired: { scheduled: string | null; withRecords: string | null };
  lastOptional: string | null;
}

export interface StudentStats {
  studentId: string;
  fullName: string;
  fatherName: string;
  instructorId: string;
  instructorName: string;
  school: string | null;
  grade: string | null;
  joined: string;
  course: {
    sessions: number;
    present: number;
    late: number;
    absent: number;
    excused: number;
    unmarked: number;
  };
  window: { sessions: number; attended: number; missed: number };
  classification: Classification;
  absentStreak: number;
  needsCall: boolean;
  lastAttended: string | null;
}

export type DayStatus = 'PRESENT' | 'LATE' | 'ABSENT' | 'EXCUSED' | 'UNMARKED';

export interface HalaqaDay {
  instructorId: string;
  instructorName: string;
  students: number;
  recorded: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  unmarked: number;
  /** Nothing at all recorded for this حلقة on the day. */
  notRecorded: boolean;
  /** Instructors (other than the حلقة's own) who recorded some of its students. */
  coveredBy: string[];
  recordedByOthers: number;
  roster: {
    studentId: string;
    fullName: string;
    fatherName: string;
    status: DayStatus;
    markedBy: string | null;
    byOther: boolean;
    /** Course counts, for "غاب كم مرة". */
    absences: number;
    absentStreak: number;
  }[];
}

export type CalendarStatus =
  | DayStatus
  | 'NO_SESSION'
  | 'NOT_ATTENDED'
  | 'UPCOMING'
  | 'BEFORE_JOIN';

export interface CalendarDay {
  date: string;
  weekday: IsoDow;
  kind: DayKind;
  status: CalendarStatus;
  markedBy: string | null;
  courseId: number | null;
}

/** Who is asking — instructors only ever see their own حلقة here. */
export interface Viewer {
  userId: string;
  role: string;
}

@Injectable()
export class AttendanceStatsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────
  // Context
  // ─────────────────────────────────────────────────────────────────────

  /**
   * The course being looked at (the active one unless `termId` is given),
   * its meeting days, and its last session days.
   */
  async courseContext(
    termId?: number,
    now: Date = new Date(),
  ): Promise<CourseContext> {
    const term = termId
      ? await this.prisma.term.findUnique({ where: { id: termId } })
      : await this.prisma.term.findFirst({ where: { isActive: true } });
    if (!term) {
      throw new NotFoundException(
        termId ? 'الدورة غير موجودة' : 'لا توجد دورة مفعّلة حالياً',
      );
    }
    const startDate = toCalendarDay(term.startDate);
    const endDate = term.endDate ? toCalendarDay(term.endDate) : null;
    const today = localToday(ATTENDANCE_RULES.localTimeZone, now);
    const measuredUntil = endDate && endDate < today ? endDate : today;

    const spread = await this.prisma.$queryRawUnsafe<
      { isodow: number; days: number }[]
    >(WEEKDAY_SPREAD_SQL, startDate, measuredUntil);
    const meetingDays = resolveMeetingDays(term, spread);

    const recorded = await this.recordedDays(startDate, measuredUntil, null);
    const lastRequired = lastSessionDay(
      today,
      startDate,
      meetingDays.required,
      recorded,
      endDate,
    );
    const lastOptional = meetingDays.optional.length
      ? lastSessionDay(
          today,
          startDate,
          meetingDays.optional,
          recorded,
          endDate,
        ).withRecords
      : null;

    return {
      term: {
        id: term.id,
        name: term.name,
        nameAr: term.nameAr,
        startDate,
        endDate,
        isActive: term.isActive,
      },
      meetingDays,
      today,
      measuredUntil,
      windowStart: addDays(measuredUntil, -(ATTENDANCE_RULES.windowDays - 1)),
      lastRequired,
      lastOptional,
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Students
  // ─────────────────────────────────────────────────────────────────────

  async studentStats(
    ctx: CourseContext,
    filter: { instructorId?: string | null; studentId?: string | null } = {},
  ): Promise<StudentStats[]> {
    const rows = await this.prisma.$queryRawUnsafe<StudentSummaryRow[]>(
      STUDENT_SUMMARY_SQL,
      ctx.term.startDate,
      ctx.measuredUntil,
      ctx.windowStart,
      `{${ctx.meetingDays.required.join(',')}}`,
      filter.instructorId ?? null,
      ATTENDANCE_RULES.localTimeZone,
      ATTENDANCE_RULES.storedTimeZone,
      filter.studentId ?? null,
    );
    return rows.map((r) => {
      const classification = classify(r.win_sessions, r.win_attended);
      return {
        studentId: r.student_id,
        fullName: r.full_name,
        fatherName: r.father_name,
        instructorId: r.instructor_id,
        instructorName: r.instructor_name,
        school: r.school,
        grade: r.grade,
        joined: r.joined,
        course: {
          sessions: r.sessions,
          present: r.present,
          late: r.late,
          absent: r.absent,
          excused: r.excused,
          unmarked: r.unmarked,
        },
        window: {
          sessions: r.win_sessions,
          attended: r.win_attended,
          missed: r.win_sessions - r.win_attended,
        },
        classification,
        absentStreak: r.absent_streak,
        needsCall: r.absent_streak >= ATTENDANCE_RULES.alertConsecutiveAbsences,
        lastAttended: r.last_attended,
      };
    });
  }

  // ─────────────────────────────────────────────────────────────────────
  // One day
  // ─────────────────────────────────────────────────────────────────────

  async day(
    ctx: CourseContext,
    date: string,
    instructorId: string | null,
  ): Promise<{ date: string; kind: DayKind; halaqas: HalaqaDay[] }> {
    const [roster, stats] = await Promise.all([
      this.prisma.$queryRawUnsafe<DayRosterRow[]>(
        DAY_ROSTER_SQL,
        date,
        instructorId,
        ATTENDANCE_RULES.localTimeZone,
        ATTENDANCE_RULES.storedTimeZone,
      ),
      this.studentStats(ctx, { instructorId }),
    ]);
    const byStudent = new Map(stats.map((s) => [s.studentId, s]));

    const halaqas = new Map<string, HalaqaDay>();
    for (const r of roster) {
      let h = halaqas.get(r.instructor_id);
      if (!h) {
        h = {
          instructorId: r.instructor_id,
          instructorName: r.instructor_name,
          students: 0,
          recorded: 0,
          present: 0,
          late: 0,
          absent: 0,
          excused: 0,
          unmarked: 0,
          notRecorded: false,
          coveredBy: [],
          recordedByOthers: 0,
          roster: [],
        };
        halaqas.set(r.instructor_id, h);
      }
      const status: DayStatus =
        r.status === null
          ? 'UNMARKED'
          : r.status === 'ABSENT' && r.excused
            ? 'EXCUSED'
            : r.status;
      h.students += 1;
      if (status === 'UNMARKED') h.unmarked += 1;
      else {
        h.recorded += 1;
        if (status === 'PRESENT') h.present += 1;
        if (status === 'LATE') h.late += 1;
        if (status === 'ABSENT') h.absent += 1;
        if (status === 'EXCUSED') h.excused += 1;
      }
      if (r.by_other) {
        h.recordedByOthers += 1;
        if (
          r.marker_role === 'INSTRUCTOR' &&
          r.marked_by_name &&
          !h.coveredBy.includes(r.marked_by_name)
        ) {
          h.coveredBy.push(r.marked_by_name);
        }
      }
      const s = byStudent.get(r.student_id);
      h.roster.push({
        studentId: r.student_id,
        fullName: r.full_name,
        fatherName: r.father_name,
        status,
        markedBy: r.marked_by_name,
        byOther: r.by_other,
        absences: s?.course.absent ?? 0,
        absentStreak: s?.absentStreak ?? 0,
      });
    }
    for (const h of halaqas.values()) h.notRecorded = h.recorded === 0;

    return {
      date,
      kind: dayKindOf(date, ctx.meetingDays),
      halaqas: [...halaqas.values()],
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Overview (admin home, course director)
  // ─────────────────────────────────────────────────────────────────────

  async overview(termId?: number, now: Date = new Date()) {
    const ctx = await this.courseContext(termId, now);
    const [students, holding] = await Promise.all([
      this.studentStats(ctx),
      this.prisma.$queryRawUnsafe<{ n: number }[]>(HOLDING_COUNT_SQL),
    ]);
    const count = (c: Classification) =>
      students.filter((s) => s.classification === c).length;

    const lastDay = ctx.lastRequired.withRecords;
    const session = lastDay ? await this.day(ctx, lastDay, null) : null;
    const sum = (
      k: 'students' | 'present' | 'late' | 'absent' | 'excused' | 'unmarked',
    ) => (session ? session.halaqas.reduce((t, h) => t + h[k], 0) : 0);

    return {
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      today: ctx.today,
      lastSession: {
        date: lastDay,
        scheduled: ctx.lastRequired.scheduled,
        /** True when the last scheduled meeting day has no record at all (holiday, or nobody recorded). */
        scheduledDayEmpty:
          !!ctx.lastRequired.scheduled &&
          ctx.lastRequired.scheduled !== lastDay,
        halaqas: session?.halaqas.length ?? 0,
        halaqasNotRecorded:
          session?.halaqas
            .filter((h) => h.notRecorded)
            .map((h) => h.instructorName) ?? [],
        expected: sum('students'),
        present: sum('present'),
        late: sum('late'),
        absent: sum('absent'),
        excused: sum('excused'),
        unmarked: sum('unmarked'),
      },
      lastOptionalSession: ctx.lastOptional,
      students: {
        total: students.length,
        active: count('REGULAR') + count('IRREGULAR'),
        regular: count('REGULAR'),
        irregular: count('IRREGULAR'),
        inactive: count('INACTIVE'),
        noData: count('NO_DATA'),
        frozen: holding[0]?.n ?? 0,
        needsCall: students.filter((s) => s.needsCall).length,
      },
      rules: {
        windowDays: ATTENDANCE_RULES.windowDays,
        regularMaxMissed: ATTENDANCE_RULES.regularMaxMissed,
        alertConsecutiveAbsences: ATTENDANCE_RULES.alertConsecutiveAbsences,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Monthly calendar of one student
  // ─────────────────────────────────────────────────────────────────────

  async studentCalendar(
    studentId: string,
    month: string,
    now: Date = new Date(),
  ) {
    const student = await this.prisma.student.findUnique({
      where: { id: studentId },
      select: {
        id: true,
        fullName: true,
        fatherName: true,
        instructorId: true,
        createdAt: true,
        deletedAt: true,
        instructor: { select: { fullName: true } },
      },
    });
    if (!student) throw new NotFoundException('الطالب غير موجود');

    const { first, last } = monthBounds(month);
    const today = localToday(ATTENDANCE_RULES.localTimeZone, now);
    const joined = localToday(
      ATTENDANCE_RULES.localTimeZone,
      student.createdAt,
    );

    const terms = await this.prisma.term.findMany({
      where: {
        startDate: { lte: new Date(`${last}T00:00:00Z`) },
        OR: [
          { endDate: null },
          { endDate: { gte: new Date(`${first}T00:00:00Z`) } },
        ],
      },
      orderBy: { startDate: 'asc' },
    });
    const courses = await Promise.all(
      terms.map(async (t) => {
        const start = toCalendarDay(t.startDate);
        const end = t.endDate ? toCalendarDay(t.endDate) : null;
        const spread = await this.prisma.$queryRawUnsafe<
          { isodow: number; days: number }[]
        >(WEEKDAY_SPREAD_SQL, start, end && end < today ? end : today);
        return {
          id: t.id,
          nameAr: t.nameAr,
          start,
          end,
          days: resolveMeetingDays(t, spread),
        };
      }),
    );
    const courseOf = (d: string) =>
      // the latest-starting course containing the day, as everywhere else
      [...courses]
        .reverse()
        .find((c) => d >= c.start && (c.end === null || d <= c.end)) ?? null;

    const [records, halaqaDays] = await Promise.all([
      this.prisma.attendance.findMany({
        where: {
          studentId,
          date: {
            gte: new Date(`${first}T00:00:00Z`),
            lte: new Date(`${last}T00:00:00Z`),
          },
        },
        select: { date: true, status: true, excused: true, markedBy: true },
      }),
      this.recordedDays(first, last, student.instructorId),
    ]);
    const markerIds = [...new Set(records.map((r) => r.markedBy))];
    const markers = markerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: markerIds } },
          select: {
            id: true,
            username: true,
            instructor: { select: { fullName: true } },
          },
        })
      : [];
    const markerName = new Map(
      markers.map((m) => [m.id, m.instructor?.fullName ?? m.username]),
    );
    const recordOn = new Map(records.map((r) => [toCalendarDay(r.date), r]));

    const days: CalendarDay[] = [];
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const course = courseOf(d);
      const rec = recordOn.get(d);
      const kind: DayKind = course ? dayKindOf(d, course.days) : 'EXTRA';
      if (!rec && (kind === 'EXTRA' || !course)) continue; // only meeting days, plus any day with a record
      let status: CalendarStatus;
      if (rec)
        status =
          rec.status === 'ABSENT' && rec.excused ? 'EXCUSED' : rec.status;
      else if (d < joined) status = 'BEFORE_JOIN';
      else if (d > today || (d === today && !halaqaDays.has(d)))
        status = 'UPCOMING';
      else if (!halaqaDays.has(d)) status = 'NO_SESSION';
      else status = kind === 'REQUIRED' ? 'UNMARKED' : 'NOT_ATTENDED';
      days.push({
        date: d,
        weekday: isoDow(d),
        kind,
        status,
        markedBy: rec ? (markerName.get(rec.markedBy) ?? null) : null,
        courseId: course?.id ?? null,
      });
    }

    const tally = (s: CalendarStatus, k?: DayKind) =>
      days.filter((d) => d.status === s && (!k || d.kind === k)).length;
    return {
      month,
      student: {
        id: student.id,
        fullName: student.fullName,
        fatherName: student.fatherName,
        instructorName: student.instructor.fullName,
        joined,
        deleted: student.deletedAt !== null,
      },
      courses: courses.map((c) => ({
        id: c.id,
        nameAr: c.nameAr,
        start: c.start,
        end: c.end,
        meetingDays: c.days,
      })),
      days,
      counts: {
        present: tally('PRESENT'),
        late: tally('LATE'),
        absent: tally('ABSENT'),
        excused: tally('EXCUSED'),
        unmarked: tally('UNMARKED'),
        optionalAttended: days.filter(
          (d) =>
            d.kind !== 'REQUIRED' &&
            (d.status === 'PRESENT' || d.status === 'LATE'),
        ).length,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Access
  // ─────────────────────────────────────────────────────────────────────

  /**
   * The حلقة an instructor may see here: always their own. Admins may ask
   * for any حلقة, or all of them (null).
   */
  async scopeInstructor(
    viewer: Viewer,
    requested?: string | null,
  ): Promise<string | null> {
    if (viewer.role === 'ADMIN') return requested ?? null;
    const own = await this.prisma.instructor.findUnique({
      where: { userId: viewer.userId },
      select: { id: true },
    });
    if (!own) throw new ForbiddenException('هذا الحساب غير مرتبط بأستاذ');
    if (requested && requested !== own.id)
      throw new ForbiddenException('يمكنك عرض إحصائيات حلقتك فقط');
    return own.id;
  }

  assertDayInCourse(ctx: CourseContext, date: string): void {
    if (
      date < ctx.term.startDate ||
      (ctx.term.endDate && date > ctx.term.endDate)
    ) {
      throw new BadRequestException('التاريخ خارج فترة الدورة');
    }
    if (date > ctx.today)
      throw new BadRequestException('لا يمكن عرض يوم لم يأتِ بعد');
  }

  // ─────────────────────────────────────────────────────────────────────

  private async recordedDays(
    from: string,
    to: string,
    instructorId: string | null,
  ): Promise<Set<string>> {
    const rows = await this.prisma.$queryRawUnsafe<
      { day: string; records: number }[]
    >(RECORDED_DAYS_SQL, from, to, instructorId);
    return new Set(rows.map((r) => r.day));
  }
}
