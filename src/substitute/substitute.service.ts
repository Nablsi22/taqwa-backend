import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ATTENDANCE_RULES } from '../attendance-stats/attendance-stats.rules';
import {
  DayKind,
  dayKindOf,
  isIsoDow,
  localToday,
} from '../attendance-stats/meeting-days';

/** Who is asking. `userId` is a user id; an instructor's own id differs. */
export interface Viewer {
  userId: string;
  role: string;
}

/** One حلقة as the «حلقات أخرى» picker shows it. */
export interface OtherHalaqa {
  instructorId: string;
  instructorName: string;
  students: number;
  /** Students of this حلقة with an attendance record on the day. */
  recorded: number;
  unmarked: number;
  /** Nothing recorded for it at all on the day. */
  notRecorded: boolean;
  /** This viewer already said «استلمت هالحلقة اليوم». */
  coveredByMe: boolean;
  /** Everyone who claimed it for the day, this viewer included. */
  coveredBy: { instructorId: string; instructorName: string }[];
}

/** A حلقة's roster for a substitute: names, nothing else. */
export interface HalaqaRoster {
  instructorId: string;
  instructorName: string;
  date: string;
  dayKind: DayKind | null;
  coveredByMe: boolean;
  students: { studentId: string; fullName: string; fatherName: string }[];
}

export interface CoverageRow {
  halaqaInstructorId: string;
  halaqaInstructorName: string;
  coveringInstructorId: string;
  coveringInstructorName: string;
  date: string;
  note: string | null;
}

/**
 * ═════════════════════════════════════════════════════════════════════════
 * Substitute recording («تسجيل بالنيابة»).
 *
 * Marking attendance or recitation for another حلقة's students already
 * works: neither route is scoped to the caller's own حلقة, and both store
 * who recorded (attendance.markedBy, recitation.instructorId). What was
 * missing is everything around it — an instructor could not even see which
 * other حلقات exist, because every /instructors route is admin-only.
 *
 * So this service adds the two read surfaces a substitute needs (the picker
 * and a names-only roster) and the one fact that cannot be derived from the
 * records: «استلمت هالحلقة اليوم», claimed before anything is recorded, so
 * the 9 pm reminder knows who to ask.
 *
 * Nothing here moves a student between حلقات, and no statistic reads the
 * coverage table: a student is always measured in his own حلقة.
 *
 * «عزل» (the holding pool) is never offered — its students are out of every
 * statistic and every reminder, so there is nothing to record for them.
 * ═════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class SubstituteService {
  constructor(private readonly prisma: PrismaService) {}

  /** Today in Damascus, as the calendar day the mosque means. */
  today(): string {
    return localToday(ATTENDANCE_RULES.localTimeZone);
  }

  /**
   * The instructor record behind a user. ADMIN has none: an admin may read
   * the picker and the coverage list, but cannot *be* a substitute, because
   * coverage is a statement by one instructor about another's حلقة.
   */
  private async instructorOf(viewer: Viewer): Promise<string | null> {
    const own = await this.prisma.instructor.findUnique({
      where: { userId: viewer.userId },
      select: { id: true },
    });
    return own?.id ?? null;
  }

  private async requireInstructor(viewer: Viewer): Promise<string> {
    const id = await this.instructorOf(viewer);
    if (!id) {
      throw new ForbiddenException(
        viewer.role === 'ADMIN'
          ? 'الاستلام بالنيابة يسجّله الأستاذ من حسابه'
          : 'هذا الحساب غير مرتبط بأستاذ',
      );
    }
    return id;
  }

  /**
   * REQUIRED / OPTIONAL / EXTRA for `date`, so the substitute screen can say
   * the same thing the instructor's own screen says before saving. null: no
   * such course. A course with no meeting days configured behaves as it did
   * before meeting days existed — every day required.
   */
  private async dayKind(
    date: string,
    termId?: number,
  ): Promise<DayKind | null> {
    const term = termId
      ? await this.prisma.term.findUnique({
          where: { id: termId },
          select: { requiredDays: true, optionalDays: true },
        })
      : await this.prisma.term.findFirst({
          where: { isActive: true },
          select: { requiredDays: true, optionalDays: true },
        });
    if (!term) return null;
    const required = (term.requiredDays ?? []).filter(isIsoDow);
    const optional = (term.optionalDays ?? []).filter(isIsoDow);
    if (required.length === 0 && optional.length === 0) return 'REQUIRED';
    return dayKindOf(date, { required, optional });
  }

  private dayOrToday(date?: string): string {
    const day = date ?? this.today();
    if (day > this.today()) {
      throw new BadRequestException('لا يمكن التسجيل في يوم لم يأتِ بعد');
    }
    return day;
  }

  // ───────────────────────────────────────────────────────────────────────
  // The picker
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Every other حلقة that has students, with how much of `date` is already
   * recorded and who claimed it. The viewer's own حلقة is left out — it has
   * its own screen — and so is «عزل».
   */
  async otherHalaqas(
    viewer: Viewer,
    date?: string,
  ): Promise<{ date: string; dayKind: DayKind | null; halaqas: OtherHalaqa[] }> {
    const day = this.dayOrToday(date);
    const own = await this.instructorOf(viewer);

    const instructors = await this.prisma.instructor.findMany({
      where: {
        isHoldingPool: false,
        ...(own ? { id: { not: own } } : {}),
        students: { some: { deletedAt: null } },
      },
      select: {
        id: true,
        fullName: true,
        students: {
          where: { deletedAt: null },
          select: { id: true },
        },
      },
      orderBy: { fullName: 'asc' },
    });
    if (instructors.length === 0) {
      return { date: day, dayKind: await this.dayKind(day), halaqas: [] };
    }

    const studentIds = instructors.flatMap((i) => i.students.map((s) => s.id));
    const ownerOf = new Map<string, string>();
    for (const i of instructors) {
      for (const s of i.students) ownerOf.set(s.id, i.id);
    }

    const [records, coverage] = await Promise.all([
      this.prisma.attendance.findMany({
        where: { date: new Date(day), studentId: { in: studentIds } },
        select: { studentId: true },
      }),
      this.prisma.halaqaCoverage.findMany({
        where: {
          date: new Date(day),
          halaqaInstructorId: { in: instructors.map((i) => i.id) },
        },
        select: {
          halaqaInstructorId: true,
          coveringInstructorId: true,
          coveringInstructor: { select: { fullName: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const recordedPerHalaqa = new Map<string, number>();
    for (const r of records) {
      const halaqa = ownerOf.get(r.studentId);
      if (!halaqa) continue;
      recordedPerHalaqa.set(halaqa, (recordedPerHalaqa.get(halaqa) ?? 0) + 1);
    }

    const coveragePerHalaqa = new Map<
      string,
      { instructorId: string; instructorName: string }[]
    >();
    for (const c of coverage) {
      const list = coveragePerHalaqa.get(c.halaqaInstructorId) ?? [];
      list.push({
        instructorId: c.coveringInstructorId,
        instructorName: c.coveringInstructor.fullName,
      });
      coveragePerHalaqa.set(c.halaqaInstructorId, list);
    }

    const halaqas: OtherHalaqa[] = instructors.map((i) => {
      const students = i.students.length;
      const recorded = recordedPerHalaqa.get(i.id) ?? 0;
      const claimed = coveragePerHalaqa.get(i.id) ?? [];
      return {
        instructorId: i.id,
        instructorName: i.fullName,
        students,
        recorded,
        unmarked: students - recorded,
        notRecorded: recorded === 0,
        coveredByMe: own != null && claimed.some((c) => c.instructorId === own),
        coveredBy: claimed,
      };
    });

    return { date: day, dayKind: await this.dayKind(day), halaqas };
  }

  /**
   * One حلقة's students, names only — what the mosque agreed a substitute
   * sees. No points, no progress, no contact details: he is recording a day,
   * not taking over the حلقة.
   */
  async halaqaRoster(
    viewer: Viewer,
    instructorId: string,
    date?: string,
    termId?: number,
  ): Promise<HalaqaRoster> {
    const day = this.dayOrToday(date);
    const own = await this.instructorOf(viewer);
    if (own && own === instructorId) {
      throw new BadRequestException('هذه حلقتك — سجّلها من شاشة الحضور');
    }

    const instructor = await this.prisma.instructor.findUnique({
      where: { id: instructorId },
      select: { id: true, fullName: true, isHoldingPool: true },
    });
    if (!instructor) throw new NotFoundException('الحلقة غير موجودة');
    if (instructor.isHoldingPool) {
      throw new BadRequestException('«عزل» ليست حلقة تُسجّل');
    }

    const [students, claimed] = await Promise.all([
      this.prisma.student.findMany({
        where: { instructorId, deletedAt: null },
        select: { id: true, fullName: true, fatherName: true },
        orderBy: { fullName: 'asc' },
      }),
      own
        ? this.prisma.halaqaCoverage.findFirst({
            where: {
              halaqaInstructorId: instructorId,
              coveringInstructorId: own,
              date: new Date(day),
            },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);

    return {
      instructorId: instructor.id,
      instructorName: instructor.fullName,
      date: day,
      dayKind: await this.dayKind(day, termId),
      coveredByMe: claimed != null,
      students: students.map((s) => ({
        studentId: s.id,
        fullName: s.fullName,
        fatherName: s.fatherName,
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // «استلمت هالحلقة اليوم»
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Claim a حلقة for a day. Idempotent: claiming twice is the same fact, so
   * the second call only refreshes the note.
   */
  async claim(
    viewer: Viewer,
    dto: { halaqaInstructorId: string; date?: string; note?: string },
  ): Promise<{ message: string; coverage: CoverageRow }> {
    const own = await this.requireInstructor(viewer);
    const day = this.dayOrToday(dto.date);
    if (own === dto.halaqaInstructorId) {
      throw new BadRequestException('هذه حلقتك أساساً');
    }

    const halaqa = await this.prisma.instructor.findUnique({
      where: { id: dto.halaqaInstructorId },
      select: { id: true, fullName: true, isHoldingPool: true },
    });
    if (!halaqa) throw new NotFoundException('الحلقة غير موجودة');
    if (halaqa.isHoldingPool) {
      throw new BadRequestException('«عزل» ليست حلقة تُسجّل');
    }

    const row = await this.prisma.halaqaCoverage.upsert({
      where: {
        halaqaInstructorId_coveringInstructorId_date: {
          halaqaInstructorId: dto.halaqaInstructorId,
          coveringInstructorId: own,
          date: new Date(day),
        },
      },
      update: { note: dto.note ?? null },
      create: {
        halaqaInstructorId: dto.halaqaInstructorId,
        coveringInstructorId: own,
        date: new Date(day),
        note: dto.note ?? null,
      },
      select: {
        date: true,
        note: true,
        halaqaInstructorId: true,
        coveringInstructorId: true,
        halaqaInstructor: { select: { fullName: true } },
        coveringInstructor: { select: { fullName: true } },
      },
    });

    return {
      message: `تم تسجيل استلامك لحلقة أ. ${halaqa.fullName} اليوم`,
      coverage: {
        halaqaInstructorId: row.halaqaInstructorId,
        halaqaInstructorName: row.halaqaInstructor.fullName,
        coveringInstructorId: row.coveringInstructorId,
        coveringInstructorName: row.coveringInstructor.fullName,
        date: day,
        note: row.note,
      },
    };
  }

  /**
   * Undo a claim. Only the substitute's own claim, and only the note: the
   * attendance he recorded stays exactly as it is — it is the حلقة's record,
   * not his, and removing it is «إلغاء التسجيل» on the sheet.
   */
  async release(
    viewer: Viewer,
    dto: { halaqaInstructorId: string; date?: string },
  ): Promise<{ message: string; removed: number }> {
    const own = await this.requireInstructor(viewer);
    const day = this.dayOrToday(dto.date);

    const { count } = await this.prisma.halaqaCoverage.deleteMany({
      where: {
        halaqaInstructorId: dto.halaqaInstructorId,
        coveringInstructorId: own,
        date: new Date(day),
      },
    });

    return {
      message: count > 0 ? 'تم التراجع عن الاستلام' : 'لا يوجد استلام لهذا اليوم',
      removed: count,
    };
  }

  /**
   * Who covered what on a day. The 9 pm reminder and the 11 pm summary read
   * this; an instructor sees only his own claims, an admin sees all of them.
   */
  async coverage(
    viewer: Viewer,
    date?: string,
  ): Promise<{ date: string; data: CoverageRow[] }> {
    const day = this.dayOrToday(date);
    const own = await this.instructorOf(viewer);
    const rows = await this.prisma.halaqaCoverage.findMany({
      where: {
        date: new Date(day),
        ...(viewer.role === 'ADMIN' ? {} : { coveringInstructorId: own ?? '' }),
      },
      select: {
        date: true,
        note: true,
        halaqaInstructorId: true,
        coveringInstructorId: true,
        halaqaInstructor: { select: { fullName: true } },
        coveringInstructor: { select: { fullName: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return {
      date: day,
      data: rows.map((r) => ({
        halaqaInstructorId: r.halaqaInstructorId,
        halaqaInstructorName: r.halaqaInstructor.fullName,
        coveringInstructorId: r.coveringInstructorId,
        coveringInstructorName: r.coveringInstructor.fullName,
        date: day,
        note: r.note,
      })),
    };
  }
}
