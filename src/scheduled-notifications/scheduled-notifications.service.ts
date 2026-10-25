import { randomUUID } from 'crypto';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { FirebaseService } from '../notification/firebase.service';
import {
  AttendanceStatsService,
  CourseContext,
} from '../attendance-stats/attendance-stats.service';
import { ATTENDANCE_RULES } from '../attendance-stats/attendance-stats.rules';
import {
  addDays,
  dayKindOf,
  isCalendarDay,
} from '../attendance-stats/meeting-days';
import {
  Message,
  SummaryHalaqa,
  absenceAlert,
  dayLabelAr,
  directorSummary,
  ownerReminder,
  rosterNames,
  substituteReminder,
} from './scheduled-notifications.compose';
import {
  CLAIM_SQL,
  CLEAR_TOKEN_SQL,
  COVERAGE_OF_DAY_SQL,
  INSTRUCTOR_RECIPIENTS_SQL,
  LOG_OF_DAY_SQL,
  SETTLE_SQL,
  SUPERVISOR_RECIPIENTS_SQL,
  USER_TOKEN_SQL,
} from './scheduled-notifications.sql';

// ═══════════════════════════════════════════════════════════════════════════
// The evening notifications (Phase 4), as agreed with the mosque:
//
//   9 pm, REQUIRED days only — «لم تسجّل»: to every أستاذ whose حلقة still
//     has students with nothing recorded, naming them; and to each teacher
//     who said «استلمتُ هذه الحلقة اليوم» for it. Never on an optional or
//     make-up day, never for «عزل», and not at all on a required day with no
//     record anywhere in the mosque (a holiday, or the mosque was closed).
//
//   9 pm and 11 pm — «اتصل واطمئن عليه»: a student whose last
//     `alertConsecutiveAbsences` required sessions are unexcused ABSENT, to
//     his own أستاذ, once per break (the key carries the day he last
//     attended). Only a fresh break is reported — the latest absence within
//     a week and the streak not longer than one session past the threshold —
//     so the day this ships nobody receives a list of students who left
//     months ago.
//
//   11 pm, on meeting days — the course director's summary of the session.
//
// Every notification is claimed in `scheduled_notifications` before it is
// sent (see CLAIM_SQL), so running a job twice never sends anything twice.
// Nothing here changes attendance, points or any student.
// ═══════════════════════════════════════════════════════════════════════════

export type NotificationKind =
  | 'ATTENDANCE_REMINDER'
  | 'ABSENCE_ALERT'
  | 'DIRECTOR_SUMMARY';

export type RecipientRole = 'INSTRUCTOR' | 'SUBSTITUTE' | 'SUPERVISOR';

/** One push to one account. [parts] are the dedup keys it stands for. */
export interface PlannedNotification {
  kind: NotificationKind;
  userId: string;
  recipient: string;
  role: RecipientRole;
  token: string | null;
  day: string;
  parts: { refKey: string; name?: string; streak?: number }[];
  /** The words for the parts actually claimed (all of them in a preview). */
  compose: (parts: PlannedNotification['parts']) => Message;
  data: Record<string, string>;
}

export interface Plan {
  /** Why nothing is planned, in Arabic, when that is the case. */
  skipped: string | null;
  items: PlannedNotification[];
}

export interface DispatchReport {
  sent: number;
  failed: number;
  /** Already handled earlier (or by another run). */
  duplicate: number;
  /** The account never registered a phone (or signed out). */
  noToken: number;
}

interface RecipientRow {
  instructor_id?: string;
  user_id: string;
  name: string;
  token: string | null;
}

interface CoverageRow {
  halaqa_instructor_id: string;
  covering_instructor_id: string;
  covering_name: string;
}

@Injectable()
export class ScheduledNotificationsService {
  private readonly logger = new Logger(ScheduledNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stats: AttendanceStatsService,
    private readonly firebase: FirebaseService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────
  // The jobs (called by ScheduledNotificationsJobs at 9 pm and 11 pm)
  // ─────────────────────────────────────────────────────────────────────

  async runEvening(now: Date = new Date()): Promise<void> {
    const ctx = await this.activeCourse(now);
    if (!ctx) return;
    await this.runOne('reminder', () => this.planReminders(ctx, ctx.today));
    await this.runOne('absence', () => this.planAbsenceAlerts(ctx));
  }

  async runNight(now: Date = new Date()): Promise<void> {
    const ctx = await this.activeCourse(now);
    if (!ctx) return;
    await this.runOne('absence', () => this.planAbsenceAlerts(ctx));
    await this.runOne('summary', () =>
      this.planDirectorSummary(ctx, ctx.today),
    );
  }

  /** One job step; a failure is logged and never stops the next step. */
  private async runOne(
    label: string,
    plan: () => Promise<Plan>,
  ): Promise<void> {
    try {
      const p = await plan();
      if (p.skipped) {
        this.logger.log(`${label}: nothing to send — ${p.skipped}`);
        return;
      }
      const r = await this.dispatch(p.items);
      this.logger.log(
        `${label}: sent ${r.sent}, failed ${r.failed}, already sent ${r.duplicate}, no device ${r.noToken}`,
      );
    } catch (e) {
      this.logger.error(`${label} failed: ${(e as Error).message}`);
    }
  }

  private async activeCourse(now: Date): Promise<CourseContext | null> {
    try {
      return await this.stats.courseContext(undefined, now);
    } catch {
      this.logger.log('no active course — evening notifications skipped');
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────────────
  // 9 pm — «لم تسجّل»
  // ─────────────────────────────────────────────────────────────────────

  async planReminders(ctx: CourseContext, date: string): Promise<Plan> {
    const outside = this.outsideCourse(ctx, date);
    if (outside) return { skipped: outside, items: [] };
    const kind = dayKindOf(date, ctx.meetingDays);
    if (kind !== 'REQUIRED') {
      return { skipped: 'ليس يوم دوام إلزامياً: لا تذكير', items: [] };
    }

    const day = await this.stats.day(ctx, date, null);
    if (!day.halaqas.some((h) => h.recorded > 0)) {
      return {
        skipped:
          'لم يُسجَّل أي حضور في أي حلقة: يُعدّ يوماً بلا جلسة، فلا تذكير',
        items: [],
      };
    }
    const open = day.halaqas.filter((h) => h.unmarked > 0);
    if (open.length === 0) {
      return { skipped: 'سُجّل حضور جميع الحلقات', items: [] };
    }

    const coverage = await this.prisma.$queryRawUnsafe<CoverageRow[]>(
      COVERAGE_OF_DAY_SQL,
      date,
    );
    const ids = new Set<string>(open.map((h) => h.instructorId));
    for (const c of coverage) ids.add(c.covering_instructor_id);
    const people = await this.recipientsByInstructor([...ids]);

    const items: PlannedNotification[] = [];
    for (const h of open) {
      const facts = {
        day: date,
        students: h.students,
        unmarked: rosterNames(
          h.roster.filter((s) => s.status === 'UNMARKED'),
        ).sort((a, b) => a.localeCompare(b, 'ar')),
        notRecorded: h.recorded === 0,
      };
      const data = {
        type: 'ATTENDANCE_REMINDER',
        date,
        halaqaInstructorId: h.instructorId,
      };
      const refKey = `${date}:halaqa:${h.instructorId}`;

      const owner = people.get(h.instructorId);
      if (owner) {
        const msg = ownerReminder(facts);
        items.push({
          kind: 'ATTENDANCE_REMINDER',
          userId: owner.user_id,
          recipient: owner.name,
          role: 'INSTRUCTOR',
          token: owner.token,
          day: date,
          parts: [{ refKey }],
          compose: () => msg,
          data,
        });
      }

      const subs = coverage.filter(
        (c) => c.halaqa_instructor_id === h.instructorId,
      );
      for (const c of subs) {
        const sub = people.get(c.covering_instructor_id);
        if (!sub) continue;
        const msg = substituteReminder({
          ...facts,
          halaqaName: h.instructorName,
          shared: subs.length > 1,
        });
        items.push({
          kind: 'ATTENDANCE_REMINDER',
          userId: sub.user_id,
          recipient: sub.name,
          role: 'SUBSTITUTE',
          token: sub.token,
          day: date,
          parts: [{ refKey }],
          compose: () => msg,
          data,
        });
      }
    }
    return { skipped: null, items };
  }

  // ─────────────────────────────────────────────────────────────────────
  // «اتصل واطمئن عليه»
  // ─────────────────────────────────────────────────────────────────────

  async planAbsenceAlerts(ctx: CourseContext): Promise<Plan> {
    const threshold = ATTENDANCE_RULES.alertConsecutiveAbsences;
    const freshSince = addDays(ctx.today, -7);
    const all = await this.stats.studentStats(ctx);
    const due = all.filter(
      (s) =>
        s.absentStreak >= threshold &&
        s.absentStreak <= threshold + 1 &&
        !!s.lastSession &&
        s.lastSession >= freshSince,
    );
    if (due.length === 0) {
      return { skipped: 'لا يوجد طالب غاب جلستين متتاليتين مؤخراً', items: [] };
    }

    // Names as his أستاذ calls them: father's name only for a shared first name.
    const byHalaqa = new Map<string, typeof due>();
    for (const s of due) {
      const list = byHalaqa.get(s.instructorId) ?? [];
      list.push(s);
      byHalaqa.set(s.instructorId, list);
    }
    const people = await this.recipientsByInstructor([...byHalaqa.keys()]);

    const items: PlannedNotification[] = [];
    for (const [instructorId, list] of byHalaqa) {
      const owner = people.get(instructorId);
      if (!owner) continue;
      const halaqa = all.filter((s) => s.instructorId === instructorId);
      const names = new Map(
        rosterNames(halaqa).map((n, i) => [halaqa[i].studentId, n] as const),
      );
      items.push({
        kind: 'ABSENCE_ALERT',
        userId: owner.user_id,
        recipient: owner.name,
        role: 'INSTRUCTOR',
        token: owner.token,
        day: ctx.today,
        parts: list.map((s) => ({
          refKey: `student:${s.studentId}:since:${s.lastAttended ?? 'none'}`,
          name: names.get(s.studentId) ?? s.fullName,
          streak: s.absentStreak,
        })),
        compose: (parts) =>
          absenceAlert(
            parts.map((p) => ({
              name: p.name ?? '',
              streak: p.streak ?? threshold,
            })),
          ),
        data: { type: 'ABSENCE_ALERT', date: ctx.today },
      });
    }
    return { skipped: null, items };
  }

  // ─────────────────────────────────────────────────────────────────────
  // 11 pm — the course director
  // ─────────────────────────────────────────────────────────────────────

  async planDirectorSummary(ctx: CourseContext, date: string): Promise<Plan> {
    const outside = this.outsideCourse(ctx, date);
    if (outside) return { skipped: outside, items: [] };
    const kind = dayKindOf(date, ctx.meetingDays);
    if (kind === 'EXTRA') {
      return { skipped: 'ليس من أيام الدوام: لا ملخص', items: [] };
    }

    const directors = await this.prisma.$queryRawUnsafe<RecipientRow[]>(
      SUPERVISOR_RECIPIENTS_SQL,
    );
    if (directors.length === 0) {
      return { skipped: 'لا يوجد حساب مدير دورة مفعّل', items: [] };
    }
    const summary = await this.summaryMessage(ctx, date, kind);
    if ('skipped' in summary) return { skipped: summary.skipped, items: [] };
    const msg = summary.message;

    return {
      skipped: null,
      items: directors.map((d) => ({
        kind: 'DIRECTOR_SUMMARY' as const,
        userId: d.user_id,
        recipient: d.name,
        role: 'SUPERVISOR' as const,
        token: d.token,
        day: date,
        parts: [{ refKey: date }],
        compose: () => msg,
        data: { type: 'DIRECTOR_SUMMARY', date },
      })),
    };
  }

  /** The words of the summary of [date] — shared by the job and the admin's test. */
  private async summaryMessage(
    ctx: CourseContext,
    date: string,
    kind: 'REQUIRED' | 'OPTIONAL',
  ): Promise<{ message: Message } | { skipped: string }> {
    const day = await this.stats.day(ctx, date, null);
    if (
      kind === 'OPTIONAL' &&
      !day.halaqas.some((h) => h.present + h.late > 0)
    ) {
      return { skipped: 'يوم اختياري لم يحضر فيه أحد: لا ملخص' };
    }

    const coverage = await this.prisma.$queryRawUnsafe<CoverageRow[]>(
      COVERAGE_OF_DAY_SQL,
      date,
    );
    const halaqas: SummaryHalaqa[] = day.halaqas.map((h) => {
      const claimed = coverage
        .filter((c) => c.halaqa_instructor_id === h.instructorId)
        .map((c) => c.covering_name);
      return {
        instructorName: h.instructorName,
        students: h.students,
        recorded: h.recorded,
        present: h.present,
        late: h.late,
        absent: h.absent,
        excused: h.excused,
        unmarked: h.unmarked,
        substitutes: [...new Set([...claimed, ...h.coveredBy])],
      };
    });
    const needsCall =
      kind === 'REQUIRED'
        ? (await this.stats.studentStats(ctx)).filter((s) => s.needsCall).length
        : 0;
    return {
      message: directorSummary({ day: date, kind, halaqas, needsCall }),
    };
  }

  // ─────────────────────────────────────────────────────────────────────
  // Sending
  // ─────────────────────────────────────────────────────────────────────

  async dispatch(
    items: readonly PlannedNotification[],
  ): Promise<DispatchReport> {
    const report: DispatchReport = {
      sent: 0,
      failed: 0,
      duplicate: 0,
      noToken: 0,
    };
    for (const item of items) {
      // No phone registered: nothing is claimed, so the alert can still go
      // out on a later run once he signs in on the app.
      if (!item.token) {
        report.noToken += 1;
        continue;
      }
      const claimed: {
        id: string;
        part: PlannedNotification['parts'][number];
      }[] = [];
      for (const part of item.parts) {
        const rows = await this.prisma.$queryRawUnsafe<{ id: string }[]>(
          CLAIM_SQL,
          randomUUID(),
          item.kind,
          item.userId,
          item.day,
          part.refKey,
        );
        if (rows[0]) claimed.push({ id: rows[0].id, part });
      }
      if (claimed.length === 0) {
        report.duplicate += 1;
        continue;
      }

      const msg = item.compose(claimed.map((c) => c.part));
      const result = await this.firebase.sendToMultipleDevices(
        [item.token],
        msg.title,
        msg.body,
        item.data,
      );
      const ok = result.success > 0;
      const dead = result.invalidTokens.length > 0;
      if (dead) {
        await this.prisma.$executeRawUnsafe(CLEAR_TOKEN_SQL, item.token);
      }
      await this.prisma.$executeRawUnsafe(
        SETTLE_SQL,
        pgTextArray(claimed.map((c) => c.id)),
        msg.title,
        msg.body,
        String(ok),
        ok ? null : dead ? 'invalid-token' : 'send-failed',
      );
      if (ok) report.sent += 1;
      else report.failed += 1;
    }
    return report;
  }

  // ─────────────────────────────────────────────────────────────────────
  // For the admin: see before it happens, read what happened, try it
  // ─────────────────────────────────────────────────────────────────────

  /** Everything that would go out for [date] (default today) — nothing is sent or recorded. */
  async preview(date?: string, now: Date = new Date()) {
    const ctx = await this.stats.courseContext(undefined, now);
    const day = date ?? ctx.today;
    if (!isCalendarDay(day)) throw new BadRequestException('تاريخ غير صالح');
    const show = (p: Plan) => ({
      skipped: p.skipped,
      items: p.items.map((i) => {
        const m = i.compose(i.parts);
        return {
          kind: i.kind,
          recipient: i.recipient,
          role: i.role,
          hasDevice: !!i.token,
          title: m.title,
          body: m.body,
        };
      }),
    });
    const [reminders, alerts, summary] = await Promise.all([
      this.planReminders(ctx, day),
      this.planAbsenceAlerts(ctx),
      this.planDirectorSummary(ctx, day),
    ]);
    return {
      date: day,
      label: dayLabelAr(day),
      kind: dayKindOf(day, ctx.meetingDays),
      schedule: {
        timeZone: ATTENDANCE_RULES.localTimeZone,
        reminder: '21:00 (وإعادة محاولة 21:30)',
        absenceAlert: '21:00 و23:00',
        directorSummary: '23:00',
      },
      reminders: show(reminders),
      /** Always as of today — a streak is about the latest sessions. */
      absenceAlerts: show(alerts),
      directorSummary: show(summary),
    };
  }

  async log(date: string) {
    if (!isCalendarDay(date)) throw new BadRequestException('تاريخ غير صالح');
    const rows = await this.prisma.$queryRawUnsafe<Record<string, unknown>[]>(
      LOG_OF_DAY_SQL,
      date,
    );
    return { date, data: rows };
  }

  /**
   * «أرسل لي تجربة»: the director's summary of the last session, sent to the
   * calling admin's own phone, marked as a test. Nothing is recorded.
   */
  async sendSample(userId: string, now: Date = new Date()) {
    const [me] = await this.prisma.$queryRawUnsafe<RecipientRow[]>(
      USER_TOKEN_SQL,
      userId,
    );
    if (!me?.token) {
      throw new BadRequestException(
        'لا يوجد هاتف مسجّل لحسابك: سجّل الخروج ثم الدخول من التطبيق على هاتفك، ثم أعد المحاولة',
      );
    }
    const ctx = await this.stats.courseContext(undefined, now);
    const last = ctx.lastRequired.withRecords;
    let msg: Message = {
      title: 'تجربة الإشعارات',
      body: 'وصلت الرسالة: الإشعارات تعمل على هذا الهاتف.',
    };
    if (last) {
      const summary = await this.summaryMessage(ctx, last, 'REQUIRED');
      if ('message' in summary) msg = summary.message;
    }
    const result = await this.firebase.sendToMultipleDevices(
      [me.token],
      `تجربة · ${msg.title}`,
      msg.body,
      { type: 'TEST' },
    );
    if (result.invalidTokens.length > 0) {
      await this.prisma.$executeRawUnsafe(CLEAR_TOKEN_SQL, me.token);
    }
    return {
      sent: result.success > 0,
      title: `تجربة · ${msg.title}`,
      body: msg.body,
    };
  }

  // ─────────────────────────────────────────────────────────────────────

  private outsideCourse(ctx: CourseContext, date: string): string | null {
    if (date < ctx.term.startDate) return 'التاريخ قبل بداية الدورة';
    if (ctx.term.endDate && date > ctx.term.endDate)
      return 'التاريخ بعد نهاية الدورة';
    if (date > ctx.today) return 'يوم لم يأتِ بعد';
    return null;
  }

  private async recipientsByInstructor(
    ids: string[],
  ): Promise<Map<string, RecipientRow>> {
    if (ids.length === 0) return new Map();
    const rows = await this.prisma.$queryRawUnsafe<RecipientRow[]>(
      INSTRUCTOR_RECIPIENTS_SQL,
      pgTextArray(ids),
    );
    return new Map(rows.map((r) => [r.instructor_id ?? '', r]));
  }
}

/**
 * A text[] parameter as a PostgreSQL array literal — the SQL files bind every
 * parameter as a string and cast it, so no driver ever has to guess a type.
 */
export function pgTextArray(values: readonly string[]): string {
  return `{${values
    .map((v) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)
    .join(',')}}`;
}
