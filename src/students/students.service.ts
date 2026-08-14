import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TermsService } from '../terms/terms.service';
import { CreateStudentDto } from './dto/create-student.dto';
import { UpdateStudentDto } from './dto/update-student.dto';
import { Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  generateCredentials,
  generateNewPassword,
  generatePassword,
  hashPassword,
} from './credentials.util';

/**
 * Lifecycle filter for the admin roster.
 *   active   → deletedAt IS NULL   (default; preserves the previous behaviour)
 *   inactive → deletedAt IS NOT NULL
 *   all      → no lifecycle predicate
 */
export type StudentStatusFilter = 'active' | 'inactive' | 'all';

export interface FindStudentsParams {
  search?: string;
  instructorId?: string;
  grade?: string;
  status?: StudentStatusFilter;
  minAge?: number;
  maxAge?: number;
  minJuz?: number;
  maxJuz?: number;
  includePages?: boolean;
  page?: number;
  limit?: number;
  all?: boolean;
  termId?: number | null;
}

@Injectable()
export class StudentsService {
  // ═══════════════════════════════════════════════════════════════════════
  // CANONICAL GRADE ORDER
  //
  // `Student.grade` is a free-text column, but a production audit of all 170
  // non-deleted rows found exactly these 12 values, with zero NULLs and zero
  // whitespace variants. The order below is pedagogical, not alphabetical:
  // Arabic collation would sort "الثامن" before "الثاني", which is wrong.
  //
  // Any value not on this list still surfaces in the filter options — it is
  // appended after the known grades rather than dropped, so a typo entered
  // through the admin form stays visible instead of silently disappearing.
  // ═══════════════════════════════════════════════════════════════════════
  private static readonly GRADE_ORDER: readonly string[] = [
    'الأول',
    'الثاني',
    'الثالث',
    'الرابع',
    'الخامس',
    'السادس',
    'السابع',
    'الثامن',
    'التاسع',
    'العاشر',
    'الحادي عشر',
    'الثاني عشر',
  ];

  // One juz is treated as 20 mushaf pages (604 pages / 30 juz ≈ 20.13).
  // This is a display-level bucket for filtering only; it is never persisted
  // and never feeds the points formula.
  private static readonly PAGES_PER_JUZ = 20;

  constructor(
    private readonly prisma: PrismaService,
    private readonly termsService: TermsService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // TERM FILTER HELPER — same semantics as PointsService:
  //   undefined → active term (default for students)
  //   0         → all terms (admin view)
  //   >0        → that specific term
  // ═══════════════════════════════════════════════════════════════════════════
  private async resolveTermWhere(
    explicit?: number | null,
  ): Promise<Prisma.PointsLogWhereInput> {
    if (explicit === 0) return {};
    if (typeof explicit === 'number' && explicit > 0) {
      return { termId: explicit };
    }
    const active = await this.termsService.getActiveTermId();
    if (active == null) return {};
    return { termId: active };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // AGE → DATE-OF-BIRTH RANGE
  //
  // Filtering is translated into a bounded range on `dateOfBirth` rather than
  // computing each student's age row by row. That keeps the predicate a plain
  // indexable comparison and, more importantly, keeps it correct: an age
  // computed in application code would drift as the process stays up across
  // midnight, whereas the bounds here are derived once per request.
  //
  //   age >= minAge  ⇔  dateOfBirth <= today − minAge years
  //   age <= maxAge  ⇔  dateOfBirth >  today − (maxAge + 1) years
  //
  // The upper bound is exclusive because someone who turns (maxAge + 1)
  // exactly today is no longer within the range.
  // ═══════════════════════════════════════════════════════════════════════════
  private dobRangeForAges(
    minAge?: number,
    maxAge?: number,
  ): Prisma.DateTimeFilter | undefined {
    if (minAge == null && maxAge == null) return undefined;

    const today = new Date();
    const shiftYears = (years: number): Date =>
      new Date(
        Date.UTC(
          today.getUTCFullYear() - years,
          today.getUTCMonth(),
          today.getUTCDate(),
        ),
      );

    const filter: Prisma.DateTimeFilter = {};
    if (minAge != null) filter.lte = shiftYears(minAge);
    if (maxAge != null) filter.gt = shiftYears(maxAge + 1);

    return filter;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECITED PAGES PER STUDENT
  //
  // Recited volume is not a column on Student; it only exists as the sum of
  // that student's `recitations` rows.
  //
  // ── Why this aggregates in TypeScript rather than in SQL ──
  //
  // The per-row value is `pagesCalculated` when present, falling back to
  // `pagesRecited`. In SQL that is a COALESCE, but the `recitations` table
  // mixes naming conventions: older fields carry an explicit @map to
  // snake_case (`pages_recited`) while newer ones were added without it and
  // are therefore quoted camelCase columns (`"pagesCalculated"`). Hand-written
  // SQL against this table is a standing hazard — the wrong guess fails at
  // runtime, not at compile time. Letting Prisma generate the column names
  // removes that class of bug entirely.
  //
  // The cost is fetching the recitation rows (1,845 at the time of writing,
  // three narrow columns) instead of aggregating server-side. At this scale
  // that is negligible. If the table ever grows past the point where it isn't,
  // the fix is a stored aggregate on Student, not a return to raw SQL.
  //
  // ⚠ CAVEAT 1 — this sums every recitation, so re-reciting the same page
  // counts each time. It measures cumulative recited volume, not distinct
  // Quran coverage. Distinct coverage would require interval-merging the aya
  // ranges per student; that is materially larger work and is not what this
  // number claims to be.
  //
  // ⚠ CAVEAT 2 — roughly half the rows predate `pagesCalculated` and fall back
  // to `pagesRecited`, which derives from the curated metadata table known to
  // overstate the mushaf by about 6% (639.75 vs 604 pages). A student's total
  // therefore mixes two methods and skews slightly high. Acceptable for a
  // browsing filter; NOT acceptable as a figure reported to families.
  //
  // Deliberately NOT term-scoped: memorisation accumulates across terms,
  // unlike points.
  // ═══════════════════════════════════════════════════════════════════════════
  private async recitedPagesByStudent(
    studentIds?: string[],
  ): Promise<Map<string, number>> {
    const recitations = await this.prisma.recitation.findMany({
      where: studentIds ? { studentId: { in: studentIds } } : undefined,
      select: {
        studentId: true,
        pagesRecited: true,
        pagesCalculated: true,
      },
    });

    const totals = new Map<string, number>();
    for (const row of recitations) {
      // pagesCalculated is Decimal(5,3) and arrives as a Prisma.Decimal —
      // Number() is mandatory, an implicit cast yields NaN.
      const pages =
        row.pagesCalculated != null
          ? Number(row.pagesCalculated)
          : Number(row.pagesRecited ?? 0);

      if (!Number.isFinite(pages)) continue;

      totals.set(row.studentId, (totals.get(row.studentId) ?? 0) + pages);
    }

    // Round to the precision of the underlying Decimal(5,3) column. Summing
    // doubles otherwise surfaces totals such as 40.00000000000001.
    for (const [id, sum] of totals) {
      totals.set(id, Math.round(sum * 1000) / 1000);
    }

    return totals;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // JUZ RANGE → STUDENT IDs
  //
  // Recited volume cannot be expressed as a Prisma `where` predicate, so the
  // qualifying IDs are resolved first and fed back in as `id: { in: [...] }`.
  // Doing it this way — rather than filtering the page after it is fetched —
  // keeps pagination and the total count honest: page 2 means the second page
  // of *matching* students.
  // ═══════════════════════════════════════════════════════════════════════════
  private async studentIdsByJuzRange(
    minJuz?: number,
    maxJuz?: number,
  ): Promise<string[] | null> {
    if (minJuz == null && maxJuz == null) return null;

    const minPages =
      minJuz != null ? minJuz * StudentsService.PAGES_PER_JUZ : null;
    const maxPages =
      maxJuz != null ? (maxJuz + 1) * StudentsService.PAGES_PER_JUZ : null;

    const [pagesByStudent, everyStudent] = await Promise.all([
      this.recitedPagesByStudent(),
      this.prisma.student.findMany({ select: { id: true } }),
    ]);

    // Students with no recitations at all are absent from the map but still
    // have a legitimate total of zero, so they are evaluated too.
    return everyStudent
      .map((s) => s.id)
      .filter((id) => {
        const pages = pagesByStudent.get(id) ?? 0;
        if (minPages != null && pages < minPages) return false;
        if (maxPages != null && pages >= maxPages) return false;
        return true;
      });
  }

  private static gradeSortIndex(grade: string): number {
    const index = StudentsService.GRADE_ORDER.indexOf(grade);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  }

  async create(dto: CreateStudentDto, createdByUserId: string) {
    const instructor = await this.prisma.instructor.findUnique({
      where: { id: dto.instructorId },
    });
    if (!instructor) {
      throw new BadRequestException('المعلم غير موجود');
    }

    const dob = new Date(dto.dateOfBirth);

    const { username, plainPassword, passwordHash } =
      await generateCredentials(this.prisma, dob);

    const user = await this.prisma.user.create({
      data: {
        username,
        passwordHash,
        role: 'STUDENT',
        isActive: true,
      },
    });

    const student = await this.prisma.student.create({
      data: {
        userId: user.id,
        fullName: dto.fullName,
        fatherName: dto.fatherName,
        dateOfBirth: dob,
        instructorId: dto.instructorId,
        school: dto.school,
        address: dto.address,
        phone1: dto.phone1,
        phone2: dto.phone2,
        grade: dto.grade || null,
      },
      include: {
        instructor: {
          include: { user: { select: { username: true } } },
        },
        _count: { select: { attendance: true, pointsLog: true } },
      },
    });

    return {
      ...student,
      generatedCredentials: {
        username,
        password: plainPassword,
      },
    };
  }

  async findAll(params?: FindStudentsParams) {
    const {
      search,
      instructorId,
      grade,
      status = 'active',
      minAge,
      maxAge,
      minJuz,
      maxJuz,
      includePages = false,
      all = false,
      termId,
    } = params || {};

    const page = Math.max(1, params?.page ?? 1);
    const limit = Math.min(500, Math.max(1, params?.limit ?? 50));
    const skip = (page - 1) * limit;

    const where: Prisma.StudentWhereInput = {};

    // Lifecycle. 'active' reproduces the previous unconditional behaviour,
    // so every existing caller that omits `status` is unaffected.
    if (status === 'active') {
      where.deletedAt = null;
    } else if (status === 'inactive') {
      where.deletedAt = { not: null };
    }

    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { fatherName: { contains: search, mode: 'insensitive' } },
        { phone1: { contains: search } },
        { phone2: { contains: search } },
      ];
    }

    if (instructorId) {
      where.instructorId = instructorId;
    }

    if (grade) {
      where.grade = grade;
    }

    const dobRange = this.dobRangeForAges(minAge, maxAge);
    if (dobRange) {
      where.dateOfBirth = dobRange;
    }

    const juzFilteredIds = await this.studentIdsByJuzRange(minJuz, maxJuz);
    if (juzFilteredIds !== null) {
      where.id = { in: juzFilteredIds };
    }

    const findManyArgs: Prisma.StudentFindManyArgs = {
      where,
      orderBy: { fullName: 'asc' },
      include: {
        user: { select: { username: true } },
        instructor: { include: { user: { select: { username: true } } } },
        _count: { select: { attendance: true, pointsLog: true } },
      },
      ...(all ? { take: 2000 } : { skip, take: limit }),
    };

    const [students, total] = await Promise.all([
      this.prisma.student.findMany(findManyArgs),
      this.prisma.student.count({ where }),
    ]);

    const studentIds = students.map((s) => s.id);

    // ── Filter points by active term so totalPoints reflects current chapter ──
    const termWhere = await this.resolveTermWhere(termId);

    // ═══════════════════════════════════════════════════════════════════════
    // TOTALS — amounts are persisted ALREADY SIGNED.
    //
    // PointsService.awardPoints() negates DEDUCT rows at write time, so the
    // sign lives in the data. Verified against production: 682 of 682 DEDUCT
    // rows are negative, 0 of 3500 EARN rows are. A plain SUM is therefore
    // the correct and only total.
    //
    // The previous implementation grouped by categoryId, looked the category
    // type up, and negated DEDUCT sums a SECOND time — turning every
    // deduction into a credit and inflating each student's total by twice
    // their deductions. Summing in the database also removes the
    // floating-point drift that surfaced totals as e.g. 211.105000000000002.
    //
    // Grouping by studentId alone additionally removes the category lookup
    // query that the old sign logic required.
    // ═══════════════════════════════════════════════════════════════════════
    const pointsGrouped = studentIds.length
      ? await this.prisma.pointsLog.groupBy({
          by: ['studentId'],
          where: { studentId: { in: studentIds }, ...termWhere },
          _sum: { amount: true },
        })
      : [];

    const totalsByStudent = new Map<string, number>();
    for (const row of pointsGrouped) {
      totalsByStudent.set(row.studentId, Number(row._sum.amount ?? 0));
    }

    // Opt-in: recited page totals, scoped to the returned page of students so
    // the default roster load pays nothing for a field it does not use.
    const pagesByStudent =
      includePages && studentIds.length
        ? await this.recitedPagesByStudent(studentIds)
        : null;

    const studentsWithPoints = students.map((student) => ({
      ...student,
      totalPoints: totalsByStudent.get(student.id) ?? 0,
      ...(pagesByStudent
        ? { totalPagesRecited: pagesByStudent.get(student.id) ?? 0 }
        : {}),
    }));

    return {
      data: studentsWithPoints,
      meta: {
        total,
        page: all ? 1 : page,
        limit: all ? total : limit,
        totalPages: all ? 1 : Math.ceil(total / limit),
        // Echo the filters back so the client can render active-filter chips
        // without having to keep its own copy in sync.
        filters: {
          search: search ?? null,
          instructorId: instructorId ?? null,
          grade: grade ?? null,
          status,
          minAge: minAge ?? null,
          maxAge: maxAge ?? null,
          minJuz: minJuz ?? null,
          maxJuz: maxJuz ?? null,
        },
        pagesPerJuz: StudentsService.PAGES_PER_JUZ,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FILTER OPTIONS — drives the admin filter bar.
  //
  // The grade list is derived from the data rather than hard-coded in Flutter,
  // so a grade that stops being used disappears from the dropdown on its own
  // and a newly introduced one appears without shipping an APK.
  //
  // Instructor counts come from a groupBy on Student rather than a relation
  // `_count` on Instructor, because the latter would also count soft-deleted
  // students and quietly overstate every حلقة.
  // ═══════════════════════════════════════════════════════════════════════════
  async getFilterOptions() {
    const [gradeGroups, instructorGroups, instructors, total] =
      await Promise.all([
        this.prisma.student.groupBy({
          by: ['grade'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        this.prisma.student.groupBy({
          by: ['instructorId'],
          where: { deletedAt: null },
          _count: { _all: true },
        }),
        this.prisma.instructor.findMany({
          select: { id: true, fullName: true },
          orderBy: { fullName: 'asc' },
        }),
        this.prisma.student.count({ where: { deletedAt: null } }),
      ]);

    const grades = gradeGroups
      .filter((g) => g.grade != null && g.grade.trim() !== '')
      .map((g) => ({
        value: g.grade as string,
        count: g._count._all,
      }))
      .sort(
        (a, b) =>
          StudentsService.gradeSortIndex(a.value) -
            StudentsService.gradeSortIndex(b.value) ||
          a.value.localeCompare(b.value, 'ar'),
      );

    const missingGrade = gradeGroups
      .filter((g) => g.grade == null || g.grade.trim() === '')
      .reduce((sum, g) => sum + g._count._all, 0);

    const countsByInstructor = new Map<string, number>();
    for (const row of instructorGroups) {
      countsByInstructor.set(row.instructorId, row._count._all);
    }

    return {
      grades,
      instructors: instructors.map((i) => ({
        id: i.id,
        fullName: i.fullName,
        count: countsByInstructor.get(i.id) ?? 0,
      })),
      meta: {
        total,
        // Non-zero here means the admin form let a student through without a
        // grade; the filter bar can surface it as a data-quality warning.
        missingGrade,
        pagesPerJuz: StudentsService.PAGES_PER_JUZ,
      },
    };
  }

  async findOne(id: string, params?: { termId?: number | null }) {
    const termWhere = await this.resolveTermWhere(params?.termId);

    const student = await this.prisma.student.findUnique({
      where: { id },
      include: {
        user: { select: { username: true } },
        instructor: { include: { user: { select: { username: true } } } },
        attendance: {
          orderBy: { date: 'desc' },
          take: 30,
        },
        pointsLog: {
          where: termWhere, // ◄── active-term filter
          orderBy: { createdAt: 'desc' },
          take: 50,
          include: { category: true },
        },
        _count: { select: { attendance: true, pointsLog: true } },
      },
    });

    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }

    // ═══════════════════════════════════════════════════════════════════════
    // TOTAL — aggregated over the FULL filtered set, not the embedded rows.
    //
    // The `pointsLog` include above is a capped preview (take: 50) meant for
    // display. Summing it, as the previous version did, silently truncated
    // the total for any student with more rows than the cap — and several
    // already exceed it.
    //
    // The sign also comes from the stored amount rather than being
    // re-derived from the category type; re-deriving it double-negated every
    // DEDUCT row. See the note in findAll() for the verification data.
    // ═══════════════════════════════════════════════════════════════════════
    const totalsAgg = await this.prisma.pointsLog.aggregate({
      where: { studentId: id, ...termWhere },
      _sum: { amount: true },
    });
    const totalPoints = Number(totalsAgg._sum.amount ?? 0);

    return { ...student, totalPoints };
  }

  async update(id: string, dto: UpdateStudentDto) {
    const exists = await this.prisma.student.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('الطالب غير موجود');
    }

    if (dto.instructorId) {
      const instructor = await this.prisma.instructor.findUnique({
        where: { id: dto.instructorId },
      });
      if (!instructor) {
        throw new BadRequestException('المعلم غير موجود');
      }
    }

    if (dto.password) {
      const student = await this.prisma.student.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (student) {
        const passwordHash = await bcrypt.hash(dto.password, 12);
        await this.prisma.user.update({
          where: { id: student.userId },
          data: { passwordHash },
        });
      }
    }

    return this.prisma.student.update({
      where: { id },
      data: {
        ...(dto.fullName && { fullName: dto.fullName }),
        ...(dto.fatherName && { fatherName: dto.fatherName }),
        ...(dto.dateOfBirth && { dateOfBirth: new Date(dto.dateOfBirth) }),
        ...(dto.instructorId && { instructorId: dto.instructorId }),
        ...(dto.school !== undefined && { school: dto.school }),
        ...(dto.address !== undefined && { address: dto.address }),
        ...(dto.phone1 !== undefined && { phone1: dto.phone1 }),
        ...(dto.phone2 !== undefined && { phone2: dto.phone2 }),
        ...(dto.grade !== undefined && { grade: dto.grade }),
      },
      include: {
        instructor: { include: { user: { select: { username: true } } } },
      },
    });
  }

  async resetPassword(id: string, _ignoredManualPassword?: string) {
    const student = await this.prisma.student.findUnique({
      where: { id },
      select: { userId: true, fullName: true },
    });
    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }

    const { plainPassword, passwordHash } = await generateNewPassword();

    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: student.userId },
        data: { passwordHash },
      }),
      this.prisma.student.update({
        where: { id },
        data: { lastCredentialReset: new Date() },
      }),
    ]);

    return {
      message: 'تم إنشاء كلمة مرور جديدة',
      newPassword: plainPassword,
      studentName: student.fullName,
    };
  }

  async remove(id: string) {
    const student = await this.prisma.student.findUnique({
      where: { id },
      select: { id: true, userId: true, fullName: true, deletedAt: true },
    });

    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }

    if (student.deletedAt) {
      return { message: 'الطالب محذوف مسبقاً', alreadyDeleted: true };
    }

    await this.prisma.$transaction([
      this.prisma.student.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
      this.prisma.user.update({
        where: { id: student.userId },
        data: { isActive: false, fcmToken: null },
      }),
    ]);

    return {
      message: 'تم حذف الطالب بنجاح',
      studentId: id,
      studentName: student.fullName,
    };
  }

  async getStudentStats(id: string, params?: { termId?: number | null }) {
    const student = await this.findOne(id, params);
    const termWhere = await this.resolveTermWhere(params?.termId);

    const attendanceCount = await this.prisma.attendance.groupBy({
      by: ['status'],
      where: { studentId: id },
      _count: true,
    });

    const pointsByCategory = await this.prisma.pointsLog.groupBy({
      by: ['categoryId'],
      where: { studentId: id, ...termWhere },
      _sum: { amount: true },
    });

    return {
      studentId: id,
      fullName: student.fullName,
      totalPoints: student.totalPoints,
      attendance: attendanceCount,
      pointsByCategory,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CREDENTIALS MANAGEMENT (unchanged)
  // ───────────────────────────────────────────────────────────────────────────

  async listCredentials(params?: {
    search?: string;
    sentFilter?: 'all' | 'sent' | 'unsent';
  }) {
    const { search, sentFilter = 'all' } = params || {};

    const where: Prisma.StudentWhereInput = { deletedAt: null };

    if (search) {
      where.OR = [
        { fullName: { contains: search, mode: 'insensitive' } },
        { phone1: { contains: search } },
        { phone2: { contains: search } },
        { user: { username: { contains: search } } },
      ];
    }

    if (sentFilter === 'sent') {
      where.credentialsSentAt = { not: null };
    } else if (sentFilter === 'unsent') {
      where.credentialsSentAt = null;
    }

    const students = await this.prisma.student.findMany({
      where,
      orderBy: { fullName: 'asc' },
      select: {
        id: true,
        fullName: true,
        phone1: true,
        phone2: true,
        credentialsSentAt: true,
        lastCredentialReset: true,
        instructor: { select: { fullName: true } },
        user: { select: { username: true } },
      },
    });

    return {
      data: students.map((s) => ({
        id: s.id,
        fullName: s.fullName,
        username: s.user.username,
        phone1: s.phone1,
        phone2: s.phone2,
        instructorName: s.instructor.fullName,
        credentialsSentAt: s.credentialsSentAt,
        lastCredentialReset: s.lastCredentialReset,
      })),
      meta: {
        total: students.length,
        sent: students.filter((s) => s.credentialsSentAt != null).length,
        unsent: students.filter((s) => s.credentialsSentAt == null).length,
      },
    };
  }

  async markCredentialsSent(id: string) {
    const student = await this.prisma.student.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!student) {
      throw new NotFoundException('الطالب غير موجود');
    }

    await this.prisma.student.update({
      where: { id },
      data: { credentialsSentAt: new Date() },
    });

    return { message: 'تم تسجيل إرسال البيانات' };
  }

  async recoverParkedUsernames() {
    const parked = await this.prisma.student.findMany({
      where: {
        deletedAt: null,
        user: { username: { startsWith: 'tmp_' } },
      },
      orderBy: [{ dateOfBirth: 'asc' }, { fullName: 'asc' }],
      include: { user: true },
    });

    if (parked.length === 0) {
      return { message: 'لا يوجد طلاب لإصلاحهم', fixed: 0, mapping: [] };
    }

    const yearStartCounters = new Map<number, number>();
    const years = [
      ...new Set(parked.map((s) => s.dateOfBirth.getFullYear())),
    ];

    for (const year of years) {
      const prefix = year.toString();
      const existing = await this.prisma.user.findMany({
        where: {
          username: { startsWith: prefix },
          NOT: { username: { startsWith: 'tmp_' } },
        },
        select: { username: true },
      });

      let maxSeq = 0;
      for (const u of existing) {
        if (u.username.length === 8) {
          const tail = parseInt(u.username.slice(4), 10);
          if (!isNaN(tail) && tail > maxSeq) maxSeq = tail;
        }
      }
      yearStartCounters.set(year, maxSeq);
    }

    const mapping: Array<{
      studentName: string;
      oldUsername: string;
      newUsername: string;
    }> = [];

    for (const student of parked) {
      const year = student.dateOfBirth.getFullYear();
      const next = (yearStartCounters.get(year) ?? 0) + 1;
      yearStartCounters.set(year, next);

      const newUsername = `${year}${next.toString().padStart(4, '0')}`;
      const oldUsername = student.user.username;

      try {
        await this.prisma.user.update({
          where: { id: student.userId },
          data: { username: newUsername },
        });

        mapping.push({
          studentName: student.fullName,
          oldUsername,
          newUsername,
        });
      } catch (err: any) {
        console.error(
          `[recoverParkedUsernames] failed for ${student.fullName}:`,
          err,
        );
        throw new BadRequestException(
          `فشل إصلاح الطالب ${student.fullName}: ${err?.message || err}`,
        );
      }
    }

    return {
      message: `تم إصلاح ${mapping.length} طالب`,
      fixed: mapping.length,
      mapping,
    };
  }

  async regenerateAllCredentials() {
    const students = await this.prisma.student.findMany({
      where: { deletedAt: null },
      orderBy: [{ dateOfBirth: 'asc' }, { createdAt: 'asc' }],
      include: {
        user: true,
        instructor: { select: { fullName: true } },
      },
    });

    if (students.length === 0) {
      return { message: 'لا يوجد طلاب', count: 0, credentials: [] };
    }

    try {
      await this.prisma.$transaction(
        students.map((s) =>
          this.prisma.user.update({
            where: { id: s.userId },
            data: { username: `tmp_${s.userId}` },
          }),
        ),
      );
    } catch (err: any) {
      console.error('[regenerateAll] phase 1 (parking) failed:', err);
      throw new BadRequestException(
        `فشل المرحلة الأولى من التحديث: ${err?.message || err}`,
      );
    }

    const results: Array<{
      studentId: string;
      fullName: string;
      username: string;
      password: string;
      phone1: string | null;
      phone2: string | null;
      instructorName: string;
    }> = [];

    const yearCounters = new Map<number, number>();

    for (const student of students) {
      try {
        const year = student.dateOfBirth.getFullYear();
        const next = (yearCounters.get(year) ?? 0) + 1;
        yearCounters.set(year, next);

        const username = `${year}${next.toString().padStart(4, '0')}`;
        const plainPassword = generatePassword();
        const passwordHash = await hashPassword(plainPassword);

        await this.prisma.$transaction([
          this.prisma.user.update({
            where: { id: student.userId },
            data: { username, passwordHash },
          }),
          this.prisma.student.update({
            where: { id: student.id },
            data: {
              lastCredentialReset: new Date(),
              credentialsSentAt: null,
            },
          }),
        ]);

        results.push({
          studentId: student.id,
          fullName: student.fullName,
          username,
          password: plainPassword,
          phone1: student.phone1,
          phone2: student.phone2,
          instructorName: student.instructor.fullName,
        });
      } catch (err: any) {
        console.error(
          `[regenerateAll] failed for student ${student.id} (${student.fullName}):`,
          err,
        );
        throw new BadRequestException(
          `فشل تحديث الطالب ${student.fullName}: ${err?.message || err}`,
        );
      }
    }

    return {
      message: `تم إنشاء بيانات دخول جديدة لـ ${results.length} طالب`,
      count: results.length,
      credentials: results,
    };
  }
}