/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return, @typescript-eslint/require-await --
   Hand-rolled doubles are untyped by design. */
import {
  absenceAlert,
  dayLabelAr,
  directorSummary,
  halaqasGenitiveAr,
  namesAr,
  ownerReminder,
  rosterNames,
  studentsAr,
  substituteReminder,
} from './scheduled-notifications.compose';
import {
  ScheduledNotificationsService,
  pgTextArray,
} from './scheduled-notifications.service';
import {
  CLAIM_SQL,
  CLEAR_TOKEN_SQL,
  COVERAGE_OF_DAY_SQL,
  INSTRUCTOR_RECIPIENTS_SQL,
  SETTLE_SQL,
  SUPERVISOR_RECIPIENTS_SQL,
} from './scheduled-notifications.sql';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4 — the evening notifications. What is protected here:
//   • the 9 pm reminder only on a REQUIRED day that actually had a session,
//     to the أستاذ and to whoever claimed his حلقة, naming the students;
//   • «اتصل واطمئن عليه» only for a fresh break, once per break;
//   • the director's summary says who did not record and who covered;
//   • a notification is never sent twice, and a dead phone is forgotten.
// ═══════════════════════════════════════════════════════════════════════════

describe('words (MSA, grammatical for any count)', () => {
  it('counts students and حلقات', () => {
    expect(studentsAr(1)).toBe('طالب واحد');
    expect(studentsAr(2)).toBe('طالبان');
    expect(studentsAr(3)).toBe('3 طلاب');
    expect(studentsAr(10)).toBe('10 طلاب');
    expect(studentsAr(11)).toBe('11 طالباً');
    expect(studentsAr(100)).toBe('100 طالب');
    expect(studentsAr(103)).toBe('103 طلاب');
    expect(halaqasGenitiveAr(2)).toBe('حلقتين');
    expect(halaqasGenitiveAr(4)).toBe('4 حلقات');
  });

  it('labels a day by its Arabic weekday', () => {
    expect(dayLabelAr('2026-10-31')).toBe('السبت 31/10');
    expect(dayLabelAr('2026-10-29')).toBe('الخميس 29/10');
  });

  it('shortens long name lists and tells twins apart', () => {
    expect(namesAr(['أ', 'ب', 'ج'], 2)).toBe('أ، ب وغيرهم');
    expect(
      rosterNames([
        { fullName: 'محمد', fatherName: 'سامر' },
        { fullName: 'محمد', fatherName: 'عماد' },
        { fullName: 'عمر', fatherName: 'خالد' },
      ]),
    ).toEqual(['محمد سامر', 'محمد عماد', 'عمر']);
  });

  it('reminds the أستاذ, naming who is left', () => {
    const partial = ownerReminder({
      day: '2026-10-31',
      students: 12,
      unmarked: ['أحمد', 'عمر'],
      notRecorded: false,
    });
    expect(partial.body).toContain(
      'بقي طالبان بلا تسجيل حضور في حلقتك اليوم: أحمد، عمر',
    );
    const none = ownerReminder({
      day: '2026-10-31',
      students: 12,
      unmarked: [],
      notRecorded: true,
    });
    expect(none.body).toContain('لم يُسجَّل حضور حلقتك اليوم (السبت 31/10)');
    expect(none.body).toContain('12 طالباً');
  });

  it('tells a substitute of a shared حلقة to record only his own', () => {
    const m = substituteReminder({
      day: '2026-10-31',
      students: 9,
      unmarked: ['يوسف'],
      notRecorded: false,
      halaqaName: 'سامر',
      shared: true,
    });
    expect(m.body).toContain('حلقة أ. سامر التي استلمتها اليوم');
    expect(m.body).toContain('سجّل من كان عندك فقط');
  });

  it('asks for a call, singular, dual and plural', () => {
    expect(absenceAlert([{ name: 'أحمد', streak: 2 }]).body).toContain(
      'غاب أحمد جلستين متتاليتين بلا عذر',
    );
    expect(absenceAlert([{ name: 'أحمد', streak: 3 }]).body).toContain(
      'ثلاث جلسات متتالية',
    );
    expect(
      absenceAlert([
        { name: 'أ', streak: 2 },
        { name: 'ب', streak: 2 },
      ]).body,
    ).toContain('عليهما');
  });

  it('summarises a session for the director', () => {
    const h = (o: object) => ({
      instructorName: 'سامر',
      students: 10,
      recorded: 10,
      present: 8,
      late: 1,
      absent: 1,
      excused: 0,
      unmarked: 0,
      substitutes: [] as string[],
      ...o,
    });
    const m = directorSummary({
      day: '2026-10-31',
      kind: 'REQUIRED',
      halaqas: [
        h({}),
        h({
          instructorName: 'بلال',
          recorded: 0,
          present: 0,
          late: 0,
          absent: 0,
          unmarked: 10,
        }),
        h({
          instructorName: 'عمار',
          recorded: 7,
          absent: 0,
          present: 7,
          late: 0,
          unmarked: 3,
          substitutes: ['أنس'],
        }),
      ],
      needsCall: 3,
    });
    expect(m.title).toBe('ملخص جلسة السبت 31/10');
    expect(m.body).toContain('حضر 16 من 30 (تأخّر منهم 1)');
    expect(m.body).toContain('لم يسجّل: أ. بلال');
    expect(m.body).toContain('لم يكتمل: أ. عمار (بقي 3)');
    expect(m.body).toContain('حلقة أ. عمار ← أ. أنس');
    expect(m.body).toContain('بحاجة إلى اتصال: 3 طلاب');

    const all = directorSummary({
      day: '2026-10-31',
      kind: 'REQUIRED',
      halaqas: [h({})],
      needsCall: 0,
    });
    expect(all.body).toContain('سجّل جميع الأساتذة الحضور كاملاً');

    const thursday = directorSummary({
      day: '2026-10-29',
      kind: 'OPTIONAL',
      halaqas: [h({}), h({ present: 0, late: 0 })],
      needsCall: 0,
    });
    expect(thursday.title).toBe('ملخص يوم الخميس 29/10 (اختياري)');
    expect(thursday.body).toContain('حضر 9 طلاب في حلقة واحدة');
  });

  it('binds a text[] as an escaped array literal', () => {
    expect(pgTextArray(['a', 'b"c', 'd\\e'])).toBe('{"a","b\\"c","d\\\\e"}');
    expect(pgTextArray([])).toBe('{}');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Planning and sending, over doubles
// ─────────────────────────────────────────────────────────────────────────

const CTX = {
  term: {
    id: 24,
    name: 'w',
    nameAr: 'الشتوية',
    startDate: '2026-09-19',
    endDate: null,
    isActive: true,
  },
  meetingDays: { required: [6], optional: [4], source: 'COURSE' },
  today: '2026-10-31',
  measuredUntil: '2026-10-31',
  windowStart: '2026-10-04',
  lastRequired: { scheduled: '2026-10-31', withRecords: '2026-10-31' },
  lastOptional: '2026-10-29',
} as any;

function halaqa(id: string, name: string, statuses: string[]) {
  const roster = statuses.map((status, i) => ({
    studentId: `${id}-s${i}`,
    fullName: `طالب${i}`,
    fatherName: 'أب',
    status,
    markedBy: null,
    byOther: false,
    absences: 0,
    absentStreak: 0,
  }));
  const count = (s: string) => statuses.filter((x) => x === s).length;
  return {
    instructorId: id,
    instructorName: name,
    students: statuses.length,
    recorded: statuses.length - count('UNMARKED'),
    present: count('PRESENT'),
    late: count('LATE'),
    absent: count('ABSENT'),
    excused: count('EXCUSED'),
    unmarked: count('UNMARKED'),
    notRecorded: count('UNMARKED') === statuses.length,
    coveredBy: [] as string[],
    recordedByOthers: 0,
    roster,
  };
}

function build(opts: {
  halaqas?: any[];
  stats?: any[];
  coverage?: any[];
  people?: any[];
  directors?: any[];
  claimed?: Set<string>;
  firebase?: (tokens: string[]) => {
    success: number;
    failure: number;
    invalidTokens: string[];
  };
}) {
  const sent: { token: string; title: string; body: string; data: any }[] = [];
  const executed: { sql: string; params: any[] }[] = [];
  const claimed = opts.claimed ?? new Set<string>();
  const prisma: any = {
    $queryRawUnsafe: async (sql: string, ...p: any[]) => {
      if (sql === COVERAGE_OF_DAY_SQL) return opts.coverage ?? [];
      if (sql === INSTRUCTOR_RECIPIENTS_SQL) {
        const literal = String(p[0]);
        const ids: string[] = JSON.parse(
          literal.replace('{', '[').replace(/}$/, ']'),
        );
        return (opts.people ?? []).filter((x) => ids.includes(x.instructor_id));
      }
      if (sql === SUPERVISOR_RECIPIENTS_SQL) return opts.directors ?? [];
      if (sql === CLAIM_SQL) {
        const key = `${p[1]}|${p[2]}|${p[4]}`;
        if (claimed.has(key)) return [];
        claimed.add(key);
        return [{ id: p[0] }];
      }
      throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
    },
    $executeRawUnsafe: async (sql: string, ...params: any[]) => {
      executed.push({ sql, params });
      return 1;
    },
  };
  const stats: any = {
    courseContext: async () => CTX,
    day: async (_c: any, date: string) => ({
      date,
      kind: 'REQUIRED',
      halaqas: opts.halaqas ?? [],
    }),
    studentStats: async () => opts.stats ?? [],
  };
  const firebase: any = {
    sendToMultipleDevices: async (
      tokens: string[],
      title: string,
      body: string,
      data: any,
    ) => {
      sent.push({ token: tokens[0], title, body, data });
      return opts.firebase
        ? opts.firebase(tokens)
        : { success: 1, failure: 0, invalidTokens: [] };
    },
  };
  return {
    service: new ScheduledNotificationsService(prisma, stats, firebase),
    sent,
    executed,
    claimed,
  };
}

const PEOPLE = [
  { instructor_id: 'i1', name: 'سامر', user_id: 'u1', token: 't1' },
  { instructor_id: 'i2', name: 'أنس', user_id: 'u2', token: 't2' },
  { instructor_id: 'i3', name: 'بلال', user_id: 'u3', token: null },
];

describe('9 pm reminder', () => {
  it('is not sent on an optional day', async () => {
    const { service } = build({});
    const p = await service.planReminders(CTX, '2026-10-29');
    expect(p.items).toHaveLength(0);
    expect(p.skipped).toContain('ليس يوم دوام إلزامياً');
  });

  it('is not sent on a required day with no record anywhere (no session)', async () => {
    const { service } = build({
      halaqas: [halaqa('i1', 'سامر', ['UNMARKED', 'UNMARKED'])],
    });
    const p = await service.planReminders(CTX, '2026-10-31');
    expect(p.items).toHaveLength(0);
    expect(p.skipped).toContain('بلا جلسة');
  });

  it('goes to the أستاذ and to each teacher who claimed his حلقة', async () => {
    const { service } = build({
      halaqas: [
        halaqa('i1', 'سامر', ['PRESENT', 'UNMARKED', 'UNMARKED']),
        halaqa('i3', 'بلال', ['PRESENT', 'ABSENT']),
      ],
      coverage: [
        {
          halaqa_instructor_id: 'i1',
          covering_instructor_id: 'i2',
          covering_name: 'أنس',
        },
      ],
      people: PEOPLE,
    });
    const p = await service.planReminders(CTX, '2026-10-31');
    expect(p.items.map((i) => [i.recipient, i.role])).toEqual([
      ['سامر', 'INSTRUCTOR'],
      ['أنس', 'SUBSTITUTE'],
    ]);
    const owner = p.items[0].compose(p.items[0].parts);
    expect(owner.body).toContain('بقي طالبان');
    expect(p.items[1].compose(p.items[1].parts).body).toContain(
      'حلقة أ. سامر التي استلمتها اليوم',
    );
    expect(p.items[0].data).toEqual({
      type: 'ATTENDANCE_REMINDER',
      date: '2026-10-31',
      halaqaInstructorId: 'i1',
    });
  });

  it('is never planned for a day that has not come, or before the course', async () => {
    const { service } = build({});
    expect((await service.planReminders(CTX, '2026-11-07')).skipped).toContain(
      'لم يأتِ',
    );
    expect((await service.planReminders(CTX, '2026-09-12')).skipped).toContain(
      'قبل بداية',
    );
  });
});

describe('«اتصل واطمئن عليه»', () => {
  const s = (o: object) => ({
    studentId: 'x',
    fullName: 'أحمد',
    fatherName: 'علي',
    instructorId: 'i1',
    absentStreak: 0,
    lastAttended: '2026-10-10',
    lastSession: '2026-10-31',
    needsCall: false,
    ...o,
  });

  it('reports only a fresh break of 2–3 sessions, grouped per أستاذ', async () => {
    const { service } = build({
      people: PEOPLE,
      stats: [
        s({ studentId: 'a', absentStreak: 2 }),
        s({ studentId: 'b', fullName: 'عمر', absentStreak: 3 }),
        s({ studentId: 'c', fullName: 'يوسف', absentStreak: 5 }), // left long ago
        s({
          studentId: 'd',
          fullName: 'زيد',
          absentStreak: 2,
          lastSession: '2026-10-17',
        }), // stale
        s({ studentId: 'e', fullName: 'بلال', absentStreak: 1 }),
      ],
    });
    const p = await service.planAbsenceAlerts(CTX);
    expect(p.items).toHaveLength(1);
    expect(p.items[0].parts.map((x) => x.refKey)).toEqual([
      'student:a:since:2026-10-10',
      'student:b:since:2026-10-10',
    ]);
    expect(p.items[0].compose(p.items[0].parts).body).toContain('أحمد، عمر');
  });

  it('is sent once per break: the second run finds it claimed', async () => {
    const claimed = new Set<string>();
    const stats = [s({ studentId: 'a', absentStreak: 2 })];
    const one = build({ people: PEOPLE, stats, claimed });
    expect(
      await one.service.dispatch(
        (await one.service.planAbsenceAlerts(CTX)).items,
      ),
    ).toEqual({
      sent: 1,
      failed: 0,
      duplicate: 0,
      noToken: 0,
    });
    const two = build({ people: PEOPLE, stats, claimed });
    const r = await two.service.dispatch(
      (await two.service.planAbsenceAlerts(CTX)).items,
    );
    expect(r.duplicate).toBe(1);
    expect(two.sent).toHaveLength(0);
  });

  it('names only the newly claimed students when some were already alerted', async () => {
    const claimed = new Set<string>([
      'ABSENCE_ALERT|u1|student:a:since:2026-10-10',
    ]);
    const { service, sent } = build({
      people: PEOPLE,
      claimed,
      stats: [
        s({ studentId: 'a', absentStreak: 2 }),
        s({ studentId: 'b', fullName: 'عمر', absentStreak: 2 }),
      ],
    });
    await service.dispatch((await service.planAbsenceAlerts(CTX)).items);
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('اتصل واطمئن على عمر');
  });
});

describe('11 pm director summary', () => {
  it('needs a director account', async () => {
    const { service } = build({ halaqas: [halaqa('i1', 'سامر', ['PRESENT'])] });
    expect(
      (await service.planDirectorSummary(CTX, '2026-10-31')).skipped,
    ).toContain('مدير دورة');
  });

  it('names who did not record and who covered', async () => {
    const h1 = halaqa('i1', 'سامر', ['PRESENT', 'PRESENT']);
    const h2 = halaqa('i3', 'بلال', ['UNMARKED']);
    const { service } = build({
      halaqas: [h1, h2],
      coverage: [
        {
          halaqa_instructor_id: 'i1',
          covering_instructor_id: 'i2',
          covering_name: 'أنس',
        },
      ],
      directors: [{ user_id: 'd1', name: 'director', token: 'td' }],
      stats: [],
    });
    const p = await service.planDirectorSummary(CTX, '2026-10-31');
    const m = p.items[0].compose(p.items[0].parts);
    expect(p.items[0].role).toBe('SUPERVISOR');
    expect(m.body).toContain('لم يسجّل: أ. بلال');
    expect(m.body).toContain('حلقة أ. سامر ← أ. أنس');
  });
});

describe('sending', () => {
  it('skips an account with no phone without claiming it, so a later run can still send', async () => {
    const { service, claimed } = build({
      halaqas: [halaqa('i3', 'بلال', ['PRESENT', 'UNMARKED'])],
      people: PEOPLE,
    });
    const r = await service.dispatch(
      (await service.planReminders(CTX, '2026-10-31')).items,
    );
    expect(r).toEqual({ sent: 0, failed: 0, duplicate: 0, noToken: 1 });
    expect(claimed.size).toBe(0);
  });

  it('forgets a phone Firebase no longer knows, and never retries it', async () => {
    const { service, executed } = build({
      halaqas: [halaqa('i1', 'سامر', ['PRESENT', 'UNMARKED'])],
      people: PEOPLE,
      firebase: (t) => ({ success: 0, failure: 1, invalidTokens: t }),
    });
    const r = await service.dispatch(
      (await service.planReminders(CTX, '2026-10-31')).items,
    );
    expect(r.failed).toBe(1);
    expect(executed.find((e) => e.sql === CLEAR_TOKEN_SQL)?.params).toEqual([
      't1',
    ]);
    const settle = executed.find((e) => e.sql === SETTLE_SQL);
    expect(settle?.params.slice(3)).toEqual(['false', 'invalid-token']);
  });
});
