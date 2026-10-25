import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceStatsService } from '../attendance-stats/attendance-stats.service';
import { ATTENDANCE_RULES } from '../attendance-stats/attendance-stats.rules';
import { addDays, isCalendarDay } from '../attendance-stats/meeting-days';
import { RecitationService } from '../recitation/recitation.service';
import { getSuraName } from '../quran-metadata/quran-metadata';

/** Longest span one recitations request may cover, in days. */
const MAX_RECITATION_SPAN_DAYS = 62;

/** One thing a student recited, Quran or one of the Nawawi ahadith. */
export interface RecitationItem {
  kind: 'QURAN' | 'HADITH';
  id: string;
  /** The day it belongs to (YYYY-MM-DD, Damascus). */
  date: string;
  createdAt: string;
  studentId: string;
  studentName: string;
  fatherName: string;
  suraNames: string[];
  startSurah: number | null;
  startAya: number | null;
  endSurah: number | null;
  endAya: number | null;
  isCompleteSura: boolean;
  pages: number;
  rating: string | null;
  homework: string | null;
  points: number;
  recordedBy: string | null;
  hadithNumber: number | null;
  hadithTitle: string | null;
}

/**
 * ═════════════════════════════════════════════════════════════════════════
 * What the course director sees inside one حلقة, beyond its recording
 * discipline: the أستاذ's own roster (the same figures his dashboard shows,
 * plus points gained and points deducted), and what his students recited.
 *
 * Read-only. The only writes in this file are the director-account routes,
 * and those are reachable by ADMIN alone (see the controller).
 * ═════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class SupervisorDetailService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: AttendanceStatsService,
    private readonly recitation: RecitationService,
  ) {}

  private static toDate(day: string): Date {
    return new Date(`${day}T00:00:00Z`);
  }

  private static iso(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  /** The calendar day of an instant, in the mosque's time zone. */
  private static localDay(d: Date): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: ATTENDANCE_RULES.localTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
  }

  private async assertHalaqa(instructorId: string) {
    const instructor = await this.prisma.instructor.findUnique({
      where: { id: instructorId },
      select: { id: true, fullName: true },
    });
    if (!instructor) throw new NotFoundException('الأستاذ غير موجود');
    return instructor;
  }

  /** Names of whoever recorded something: a user id or an instructor id. */
  private async recorderNames(ids: string[]): Promise<Map<string, string>> {
    const names = new Map<string, string>();
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return names;
    const [instructors, users] = await Promise.all([
      this.prisma.instructor.findMany({
        where: { OR: [{ id: { in: unique } }, { userId: { in: unique } }] },
        select: { id: true, userId: true, fullName: true },
      }),
      this.prisma.user.findMany({
        where: { id: { in: unique } },
        select: { id: true, username: true },
      }),
    ]);
    for (const u of users) names.set(u.id, u.username);
    for (const i of instructors) {
      names.set(i.id, i.fullName);
      names.set(i.userId, i.fullName);
    }
    return names;
  }

  // ───────────────────────────────────────────────────────────────────────
  // The أستاذ's roster, as his own dashboard shows it, with points split
  // ───────────────────────────────────────────────────────────────────────

  async roster(instructorId: string, termId?: number) {
    const ctx = await this.stats.courseContext(termId);
    await this.assertHalaqa(instructorId);

    const overview = await this.recitation.getInstructorOverview(instructorId, {
      termId: ctx.term.id,
    });
    const ids = overview.data.map((s) => s.studentId);

    const [gained, deducted, extra] =
      ids.length === 0
        ? [[], [], []]
        : await Promise.all([
            this.prisma.pointsLog.groupBy({
              by: ['studentId'],
              where: {
                studentId: { in: ids },
                termId: ctx.term.id,
                amount: { gt: 0 },
              },
              _sum: { amount: true },
            }),
            this.prisma.pointsLog.groupBy({
              by: ['studentId'],
              where: {
                studentId: { in: ids },
                termId: ctx.term.id,
                amount: { lt: 0 },
              },
              _sum: { amount: true },
            }),
            this.prisma.student.findMany({
              where: { id: { in: ids } },
              select: { id: true, fatherName: true, school: true, grade: true },
            }),
          ]);

    const sum = (
      rows: { studentId: string; _sum: { amount: Prisma.Decimal | null } }[],
    ) => new Map(rows.map((r) => [r.studentId, Number(r._sum.amount ?? 0)]));
    const plus = sum(gained);
    const minus = sum(deducted);
    const info = new Map(extra.map((s) => [s.id, s]));

    return {
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      data: overview.data.map((s) => ({
        ...s,
        fatherName: info.get(s.studentId)?.fatherName ?? '',
        school: info.get(s.studentId)?.school ?? null,
        grade: info.get(s.studentId)?.grade ?? null,
        pointsGained: plus.get(s.studentId) ?? 0,
        // Negative, as stored: e.g. −7 for one absence and one late.
        pointsDeducted: minus.get(s.studentId) ?? 0,
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // What the حلقة's students recited between two days (default: the last
  // session day of the course)
  // ───────────────────────────────────────────────────────────────────────

  async recitations(
    instructorId: string,
    q: { from?: string; to?: string; termId?: number },
  ) {
    const ctx = await this.stats.courseContext(q.termId);
    await this.assertHalaqa(instructorId);

    const end = q.to ?? q.from ?? ctx.lastRequired.withRecords ?? ctx.today;
    const start = q.from ?? end;
    if (!isCalendarDay(start) || !isCalendarDay(end)) {
      throw new BadRequestException('تاريخ غير صالح');
    }
    if (start > end) throw new BadRequestException('تاريخ البداية بعد النهاية');
    if (addDays(start, MAX_RECITATION_SPAN_DAYS) < end) {
      throw new BadRequestException(
        `المدة لا تزيد عن ${MAX_RECITATION_SPAN_DAYS} يوماً`,
      );
    }

    const students = await this.prisma.student.findMany({
      where: { instructorId, deletedAt: null },
      select: { id: true, fullName: true, fatherName: true },
    });
    const byId = new Map(students.map((s) => [s.id, s]));
    const ids = students.map((s) => s.id);
    if (ids.length === 0) {
      return {
        course: { ...ctx.term, meetingDays: ctx.meetingDays },
        from: start,
        to: end,
        data: [],
      };
    }

    const [quran, hadith, rules] = await Promise.all([
      this.prisma.recitation.findMany({
        where: {
          studentId: { in: ids },
          date: {
            gte: SupervisorDetailService.toDate(start),
            lte: SupervisorDetailService.toDate(end),
          },
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      }),
      // hadith_recitations has no calendar day, only created_at: fetch a
      // margin around the range and keep the rows whose Damascus day fits.
      this.prisma.hadithRecitation.findMany({
        where: {
          studentId: { in: ids },
          createdAt: {
            gte: SupervisorDetailService.toDate(addDays(start, -1)),
            lt: SupervisorDetailService.toDate(addDays(end, 2)),
          },
        },
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.hadithPointsRule.findMany({
        select: { hadithNumber: true, title: true },
      }),
    ]);

    const hadithInRange = hadith.filter((h) => {
      const d = SupervisorDetailService.localDay(h.createdAt);
      return d >= start && d <= end;
    });

    const points = new Map<string, number>();
    if (quran.length > 0) {
      const grouped = await this.prisma.pointsLog.groupBy({
        by: ['sourceId'],
        where: {
          sourceType: 'RECITATION',
          sourceId: { in: quran.map((r) => r.id) },
        },
        _sum: { amount: true },
      });
      for (const g of grouped) {
        if (g.sourceId) points.set(g.sourceId, Number(g._sum.amount ?? 0));
      }
    }
    const titles = new Map(rules.map((r) => [r.hadithNumber, r.title]));
    const recorders = await this.recorderNames([
      ...quran.map((r) => r.instructorId),
      ...hadithInRange.map((h) => h.instructorId),
    ]);

    const items: RecitationItem[] = [
      ...quran.map((r): RecitationItem => {
        const nums =
          r.surahNumbers.length > 0 ? r.surahNumbers : [r.surahNumber];
        const s = byId.get(r.studentId);
        return {
          kind: 'QURAN',
          id: r.id,
          date: SupervisorDetailService.iso(r.date),
          createdAt: r.createdAt.toISOString(),
          studentId: r.studentId,
          studentName: s?.fullName ?? '',
          fatherName: s?.fatherName ?? '',
          suraNames: nums.map((n) => getSuraName(n)),
          startSurah: r.startSurah,
          startAya: r.startAya,
          endSurah: r.endSurah,
          endAya: r.endAya,
          isCompleteSura: r.isCompleteSura,
          pages:
            r.pagesCalculated != null
              ? Number(r.pagesCalculated)
              : r.pagesRecited,
          rating: r.rating,
          homework: r.homework,
          points: points.get(r.id) ?? 0,
          recordedBy: recorders.get(r.instructorId) ?? null,
          hadithNumber: null,
          hadithTitle: null,
        };
      }),
      ...hadithInRange.map((h): RecitationItem => {
        const s = byId.get(h.studentId);
        return {
          kind: 'HADITH',
          id: h.id,
          date: SupervisorDetailService.localDay(h.createdAt),
          createdAt: h.createdAt.toISOString(),
          studentId: h.studentId,
          studentName: s?.fullName ?? '',
          fatherName: s?.fatherName ?? '',
          suraNames: [],
          startSurah: null,
          startAya: null,
          endSurah: null,
          endAya: null,
          isCompleteSura: false,
          pages: 0,
          rating: null,
          homework: null,
          points: h.pointsAwarded,
          recordedBy: recorders.get(h.instructorId) ?? null,
          hadithNumber: h.hadithNumber,
          hadithTitle: titles.get(h.hadithNumber) ?? null,
        };
      }),
    ].sort((a, b) =>
      a.date !== b.date
        ? a.date < b.date
          ? 1
          : -1
        : a.createdAt < b.createdAt
          ? 1
          : -1,
    );

    return {
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      from: start,
      to: end,
      data: items,
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // The أستاذ's own presence, as the administration recorded it
  // ───────────────────────────────────────────────────────────────────────

  async presence(instructorId: string, termId?: number) {
    const ctx = await this.stats.courseContext(termId);
    await this.assertHalaqa(instructorId);
    const rows = await this.prisma.instructorAttendance.findMany({
      where: {
        instructorId,
        date: {
          gte: SupervisorDetailService.toDate(ctx.term.startDate),
          lte: SupervisorDetailService.toDate(ctx.measuredUntil),
        },
      },
      orderBy: { date: 'desc' },
      select: { date: true, present: true, notes: true },
    });
    return {
      course: { ...ctx.term, meetingDays: ctx.meetingDays },
      data: rows.map((r) => ({
        date: SupervisorDetailService.iso(r.date),
        present: r.present,
        notes: r.notes,
      })),
    };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Director accounts — ADMIN only (enforced by the controller)
  // ───────────────────────────────────────────────────────────────────────

  private static readonly accountSelect = {
    id: true,
    username: true,
    isActive: true,
    lastLogin: true,
    createdAt: true,
  } as const;

  async accounts() {
    const data = await this.prisma.user.findMany({
      where: { role: 'SUPERVISOR', deletedAt: null },
      select: SupervisorDetailService.accountSelect,
      orderBy: { createdAt: 'asc' },
    });
    return { data };
  }

  async createAccount(username: string, password: string) {
    const name = username.trim();
    const taken = await this.prisma.user.findUnique({
      where: { username: name },
    });
    if (taken) throw new ConflictException('اسم المستخدم مستخدم مسبقاً');
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      const data = await this.prisma.user.create({
        data: { username: name, passwordHash, role: 'SUPERVISOR' },
        select: SupervisorDetailService.accountSelect,
      });
      return { data };
    } catch (e) {
      if (
        e instanceof Prisma.PrismaClientKnownRequestError &&
        e.code === 'P2002'
      ) {
        throw new ConflictException('اسم المستخدم مستخدم مسبقاً');
      }
      throw e;
    }
  }

  private async supervisorAccount(id: string) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user || user.role !== 'SUPERVISOR' || user.deletedAt) {
      throw new NotFoundException('حساب مدير الدورة غير موجود');
    }
    return user;
  }

  async setPassword(id: string, password: string) {
    await this.supervisorAccount(id);
    const passwordHash = await bcrypt.hash(password, 12);
    const data = await this.prisma.user.update({
      where: { id },
      data: { passwordHash },
      select: SupervisorDetailService.accountSelect,
    });
    return { data };
  }

  async setActive(id: string, isActive: boolean) {
    await this.supervisorAccount(id);
    const data = await this.prisma.user.update({
      where: { id },
      data: { isActive },
      select: SupervisorDetailService.accountSelect,
    });
    return { data };
  }
}
