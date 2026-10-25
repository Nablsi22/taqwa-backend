/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The words of the evening notifications — pure functions, no I/O.
 *
 * Modern Standard Arabic throughout (the app's rule), and phrased so the
 * grammar holds for any count: numbers are always the subject of a verb
 * («بقي 3 طلاب» · «بقي طالبان» · «بقي 12 طالباً») or stand alone
 * («حضر 58 من 140»), never after a preposition, where the dual and the
 * plural would need another case.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { IsoDow, isoDow } from '../attendance-stats/meeting-days';

const WEEKDAY_AR: Record<IsoDow, string> = {
  1: 'الاثنين',
  2: 'الثلاثاء',
  3: 'الأربعاء',
  4: 'الخميس',
  5: 'الجمعة',
  6: 'السبت',
  7: 'الأحد',
};

/** '2026-10-31' → 'السبت 31/10'. */
export function dayLabelAr(day: string): string {
  const [, m, d] = day.split('-');
  return `${WEEKDAY_AR[isoDow(day)]} ${Number(d)}/${Number(m)}`;
}

/** Nominative count of students: «طالب واحد» · «طالبان» · «3 طلاب» · «12 طالباً» · «100 طالب». */
export function studentsAr(n: number): string {
  if (n === 1) return 'طالب واحد';
  if (n === 2) return 'طالبان';
  const r = n % 100;
  if (r >= 3 && r <= 10) return `${n} طلاب`;
  if (r === 0 || r === 1 || r === 2) return `${n} طالب`;
  return `${n} طالباً`;
}

/** After «في»: «حلقة واحدة» · «حلقتين» · «3 حلقات» · «11 حلقة». */
export function halaqasGenitiveAr(n: number): string {
  if (n === 1) return 'حلقة واحدة';
  if (n === 2) return 'حلقتين';
  const r = n % 100;
  if (r >= 3 && r <= 10) return `${n} حلقات`;
  return `${n} حلقة`;
}

/** «أحمد، عمر، يوسف» — at most [max] names, then «وغيرهم». */
export function namesAr(names: readonly string[], max = 6): string {
  if (names.length <= max) return names.join('، ');
  return `${names.slice(0, max).join('، ')} وغيرهم`;
}

/** «جلستين متتاليتين» · «ثلاث جلسات متتالية» · «4 جلسات متتالية». */
export function streakAr(n: number): string {
  if (n === 2) return 'جلستين متتاليتين';
  if (n === 3) return 'ثلاث جلسات متتالية';
  return `${n} جلسات متتالية`;
}

/**
 * Students of one حلقة as the أستاذ calls them: the first name, with the
 * father's name only where two students share it — the same rule as the
 * app's screens.
 */
export function rosterNames(
  roster: readonly { fullName: string; fatherName: string }[],
): string[] {
  const counts = new Map<string, number>();
  for (const s of roster) {
    const k = s.fullName.trim();
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return roster.map((s) => {
    const name = s.fullName.trim();
    return (counts.get(name) ?? 0) > 1 && s.fatherName.trim()
      ? `${name} ${s.fatherName.trim()}`
      : name;
  });
}

export interface Message {
  title: string;
  body: string;
}

// ─────────────────────────────────────────────────────────────────────────
// 9 pm — «لم تسجّل»
// ─────────────────────────────────────────────────────────────────────────

export interface ReminderFacts {
  day: string;
  /** Students of the حلقة expected that day. */
  students: number;
  /** Names of those with nothing recorded. */
  unmarked: readonly string[];
  /** Nothing at all recorded for the حلقة. */
  notRecorded: boolean;
}

/** To the حلقة's own أستاذ. */
export function ownerReminder(f: ReminderFacts): Message {
  const title = 'تذكير بتسجيل الحضور';
  if (f.notRecorded) {
    return {
      title,
      body:
        `لم يُسجَّل حضور حلقتك اليوم (${dayLabelAr(f.day)}) بعد، ` +
        `وفيها ${studentsAr(f.students)}. افتح «تسجيل الحضور» لتسجيله.`,
    };
  }
  return {
    title,
    body:
      `بقي ${studentsAr(f.unmarked.length)} بلا تسجيل حضور في حلقتك اليوم: ` +
      `${namesAr(f.unmarked)}. افتح «تسجيل الحضور» لإكماله.`,
  };
}

/**
 * To a substitute who said «استلمتُ هذه الحلقة اليوم». When several did, the
 * students may be shared out, so he is told to pass over those not with him.
 */
export function substituteReminder(
  f: ReminderFacts & { halaqaName: string; shared: boolean },
): Message {
  const head = `حلقة أ. ${f.halaqaName} التي استلمتها اليوم: `;
  const tail = f.shared ? ' (الحلقة موزّعة؛ سجّل من كان عندك فقط.)' : '';
  if (f.notRecorded) {
    return {
      title: 'تذكير بتسجيل الحضور',
      body: `${head}لم يُسجَّل حضور أيٍّ من طلابها بعد، وفيها ${studentsAr(f.students)}.${tail}`,
    };
  }
  return {
    title: 'تذكير بتسجيل الحضور',
    body: `${head}بقي ${studentsAr(f.unmarked.length)} بلا تسجيل: ${namesAr(f.unmarked)}.${tail}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// «غاب جلستين متتاليتين — اتصل واطمئن عليه»
// ─────────────────────────────────────────────────────────────────────────

export function absenceAlert(
  students: readonly { name: string; streak: number }[],
): Message {
  if (students.length === 1) {
    const s = students[0];
    return {
      title: `اتصل واطمئن على ${s.name}`,
      body:
        `غاب ${s.name} ${streakAr(s.streak)} بلا عذر. ` +
        'يُستحسن الاتصال بأهله للاطمئنان عليه.',
    };
  }
  const dual = students.length === 2;
  return {
    title: 'طلاب يحتاجون إلى اتصال',
    body:
      `غاب من حلقتك ${streakAr(2)} أو أكثر بلا عذر: ` +
      `${namesAr(students.map((s) => s.name))}. ` +
      (dual
        ? 'يُستحسن الاتصال بأهلهما للاطمئنان عليهما.'
        : 'يُستحسن الاتصال بأهلهم للاطمئنان عليهم.'),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// 11 pm — the course director's summary
// ─────────────────────────────────────────────────────────────────────────

export interface SummaryHalaqa {
  instructorName: string;
  students: number;
  recorded: number;
  present: number;
  late: number;
  absent: number;
  excused: number;
  unmarked: number;
  /** Substitutes, from «استلمتُ» claims and from who actually recorded. */
  substitutes: readonly string[];
}

export function directorSummary(f: {
  day: string;
  kind: 'REQUIRED' | 'OPTIONAL';
  halaqas: readonly SummaryHalaqa[];
  needsCall: number;
}): Message {
  const sum = (
    k: keyof Omit<SummaryHalaqa, 'instructorName' | 'substitutes'>,
  ) => f.halaqas.reduce((t, h) => t + h[k], 0);
  const attended = sum('present') + sum('late');

  if (f.kind === 'OPTIONAL') {
    const held = f.halaqas.filter((h) => h.present + h.late > 0).length;
    return {
      title: `ملخص يوم ${dayLabelAr(f.day)} (اختياري)`,
      body:
        `حضر ${studentsAr(attended)} في ${halaqasGenitiveAr(held)}. ` +
        'يوم اختياري: يُكافأ الحاضر ولا يُحتسب فيه غياب.',
    };
  }

  const title = `ملخص جلسة ${dayLabelAr(f.day)}`;
  const recordedAny = f.halaqas.some((h) => h.recorded > 0);
  if (!recordedAny) {
    return {
      title,
      body:
        'لم يُسجَّل أي حضور في جلسة اليوم في أي حلقة. ' +
        'إن لم تكن هناك جلسة اليوم فلا عليك من هذه الرسالة.',
    };
  }

  const lines: string[] = [];
  const parts = [
    `حضر ${attended} من ${sum('students')}` +
      (sum('late') > 0 ? ` (تأخّر منهم ${sum('late')})` : ''),
  ];
  if (sum('absent') > 0) parts.push(`غائب ${sum('absent')}`);
  if (sum('excused') > 0) parts.push(`بعذر ${sum('excused')}`);
  if (sum('unmarked') > 0) parts.push(`لم يُسجَّل ${sum('unmarked')}`);
  lines.push(`${parts.join(' · ')}.`);

  const none = f.halaqas.filter((h) => h.recorded === 0);
  const partial = f.halaqas.filter((h) => h.recorded > 0 && h.unmarked > 0);
  if (none.length === 0 && partial.length === 0) {
    lines.push('سجّل جميع الأساتذة الحضور كاملاً.');
  } else {
    if (none.length > 0) {
      lines.push(
        `لم يسجّل: ${namesAr(
          none.map((h) => `أ. ${h.instructorName}`),
          8,
        )}.`,
      );
    }
    if (partial.length > 0) {
      lines.push(
        `لم يكتمل: ${namesAr(
          partial.map((h) => `أ. ${h.instructorName} (بقي ${h.unmarked})`),
          6,
        )}.`,
      );
    }
  }

  const covered = f.halaqas.filter((h) => h.substitutes.length > 0);
  if (covered.length > 0) {
    lines.push(
      `استلام حلقات: ${covered
        .map(
          (h) =>
            `حلقة أ. ${h.instructorName} ← ${h.substitutes.map((n) => `أ. ${n}`).join(' و')}`,
        )
        .join('؛ ')}.`,
    );
  }

  if (f.needsCall > 0) {
    lines.push(`بحاجة إلى اتصال: ${studentsAr(f.needsCall)}.`);
  }

  return { title, body: lines.join('\n') };
}
