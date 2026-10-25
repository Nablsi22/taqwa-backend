/* eslint-disable @typescript-eslint/no-unsafe-argument --
   Hand-rolled Prisma/stats doubles are untyped by design. */
import { SupervisorService } from './supervisor.service';
import { lastRequiredDays, scheduledDays } from './meeting-calendar';

// ═══════════════════════════════════════════════════════════════════════════
// The course director's view: did each أستاذ record, and how late.
//
// The rules being protected:
//   • the calendar is the course's own meeting days (winter Sat + Thu,
//     summer Sat + Mon + Wed), so an أستاذ who never recorded still appears;
//   • an optional day (Thursday) is never a failure to record;
//   • a day a substitute recorded is not held against the حلقة's own أستاذ;
//   • the lag is measured from the FIRST mark, so a later correction never
//     makes an أستاذ look late;
//   • the list arrives worst-first, because the order is the oversight.
// ═══════════════════════════════════════════════════════════════════════════

// Winter 2026-27: Saturday (ISO 6) required, Thursday (ISO 4) optional.
const WINTER = { required: [6] as const, optional: [4] as const };
// Summer: Saturday, Monday, Wednesday, all required.
const SUMMER = { required: [6, 1, 3] as const, optional: [] as const };

describe('scheduledDays', () => {
  it('lists the winter course meeting days with their kind', () => {
    // 2026-10-12 is a Monday; the range covers two weeks.
    expect(scheduledDays('2026-10-12', '2026-10-25', WINTER)).toEqual([
      { date: '2026-10-15', kind: 'OPTIONAL' }, // Thursday
      { date: '2026-10-17', kind: 'REQUIRED' }, // Saturday
      { date: '2026-10-22', kind: 'OPTIONAL' },
      { date: '2026-10-24', kind: 'REQUIRED' },
    ]);
  });

  it('lists three required days a week in summer', () => {
    expect(scheduledDays('2026-07-04', '2026-07-10', SUMMER)).toEqual([
      { date: '2026-07-04', kind: 'REQUIRED' }, // Saturday
      { date: '2026-07-06', kind: 'REQUIRED' }, // Monday
      { date: '2026-07-08', kind: 'REQUIRED' }, // Wednesday
    ]);
  });

  it('returns nothing for a course with no meeting days configured', () => {
    // With no schedule, nobody was due to record on any day: reporting every
    // calendar day as missed would accuse أساتذة of a duty never set.
    expect(
      scheduledDays('2026-10-01', '2026-10-31', { required: [], optional: [] }),
    ).toEqual([]);
  });

  it('returns nothing when the range is inverted', () => {
    expect(scheduledDays('2026-10-25', '2026-10-12', WINTER)).toEqual([]);
  });
});

describe('lastRequiredDays', () => {
  it('takes the last N required days, oldest first, ignoring optional ones', () => {
    expect(lastRequiredDays('2026-09-01', '2026-10-17', WINTER, 4)).toEqual([
      '2026-09-26',
      '2026-10-03',
      '2026-10-10',
      '2026-10-17',
    ]);
  });

  it('returns everything it has when the course is younger than N sessions', () => {
    expect(lastRequiredDays('2026-10-05', '2026-10-17', WINTER, 4)).toEqual([
      '2026-10-10',
      '2026-10-17',
    ]);
  });
});

// ── the service ───────────────────────────────────────────────────────────

/** A row as RECORDING_DISCIPLINE_SQL returns it. */
function row(
  instructorId: string,
  name: string,
  date: string,
  opts: {
    recordedAt?: string | null;
    lag?: number | null;
    by?: string | null;
    byOther?: boolean;
    marks?: number;
    students?: number;
  } = {},
) {
  const recorded = opts.recordedAt != null;
  return {
    instructor_id: instructorId,
    instructor_name: name,
    students: opts.students ?? 10,
    date,
    recorded,
    recorded_at: opts.recordedAt ?? null,
    lag_days: recorded ? (opts.lag ?? 0) : null,
    marked_by_name: opts.by ?? (recorded ? name : null),
    by_other: opts.byOther ?? false,
    marks: opts.marks ?? (recorded ? 10 : 0),
  };
}

const DAYS = ['2026-09-26', '2026-10-03', '2026-10-10', '2026-10-17'];

function build(rows: any[]) {
  const prisma: any = { $queryRawUnsafe: jest.fn().mockResolvedValue(rows) };
  const stats: any = {
    courseContext: jest.fn().mockResolvedValue({
      term: {
        id: 24,
        name: 'winter-2026-2027',
        nameAr: 'الدورة الشتوية',
        startDate: '2026-09-01',
        endDate: null,
      },
      meetingDays: { required: [6], optional: [4], source: 'COURSE' },
      measuredUntil: '2026-10-17',
      windowStart: '2026-09-19',
      today: '2026-10-21',
      lastRequired: { scheduled: '2026-10-17', withRecords: '2026-10-17' },
    }),
    studentStats: jest.fn().mockResolvedValue([]),
    day: jest.fn().mockResolvedValue({ date: '2026-10-17', kind: 'REQUIRED', halaqas: [] }),
    overview: jest.fn().mockResolvedValue({}),
    assertDayInCourse: jest.fn(),
  };
  return { service: new SupervisorService(prisma, stats), prisma, stats };
}

describe('SupervisorService.instructors', () => {
  it('asks the database only for the last four required days', async () => {
    const { service, prisma } = build([]);
    await service.instructors(undefined, 4);
    const args = prisma.$queryRawUnsafe.mock.calls[0];
    expect(args[1]).toBe('2026-09-26');
    expect(args[2]).toBe('2026-10-17');
    expect(args[3]).toBe('{2026-09-26,2026-10-03,2026-10-10,2026-10-17}');
    expect(args[4]).toBe('Asia/Damascus');
    expect(args[5]).toBe('UTC');
  });

  it('counts same-day, late and missed separately', async () => {
    const { service } = build([
      row('i1', 'أ. نور', DAYS[0], { recordedAt: '2026-09-26T16:10', lag: 0 }),
      row('i1', 'أ. نور', DAYS[1], { recordedAt: '2026-10-04T20:30', lag: 1 }),
      row('i1', 'أ. نور', DAYS[2], { recordedAt: '2026-10-10T17:00', lag: 0 }),
      row('i1', 'أ. نور', DAYS[3], { recordedAt: '2026-10-17T23:20', lag: 0 }),
    ]);
    const res = await service.instructors();
    expect(res.data[0]).toMatchObject({
      instructorId: 'i1',
      requiredCount: 4,
      recordedCount: 4,
      missedCount: 0,
      sameDayCount: 3,
      lateCount: 1,
      avgLagDays: 0.3,
      neverRecorded: false,
    });
    expect(res.data[0].lastRecorded).toEqual({
      date: '2026-10-17',
      recordedAt: '2026-10-17T23:20',
      lagDays: 0,
    });
  });

  it('does not hold a covered day against the حلقة own أستاذ', async () => {
    const { service } = build([
      row('i1', 'أ. خالد', DAYS[0], { recordedAt: '2026-09-27T10:00', lag: 1 }),
      row('i1', 'أ. خالد', DAYS[1], { recordedAt: '2026-10-03T16:00', lag: 0 }),
      row('i1', 'أ. خالد', DAYS[2]),
      // Recorded on the day itself, but by أ. سامر standing in.
      row('i1', 'أ. خالد', DAYS[3], {
        recordedAt: '2026-10-17T18:10',
        lag: 0,
        by: 'أ. سامر',
        byOther: true,
      }),
    ]);
    const [d] = (await service.instructors()).data;
    expect(d.missedCount).toBe(1); // only 10/10, which nobody recorded
    expect(d.coveredCount).toBe(1);
    expect(d.recordedCount).toBe(3);
    // The substitute's promptness is not counted as his own.
    expect(d.sameDayCount).toBe(1);
    expect(d.avgLagDays).toBe(0.5);
    expect(d.sessions[3]).toMatchObject({
      byOther: true,
      markedByName: 'أ. سامر',
      missed: false,
    });
  });

  it('marks an أستاذ who never recorded, and still reports his days', async () => {
    const { service } = build(DAYS.map((d) => row('i9', 'أ. طارق', d, { students: 9 })));
    const [d] = (await service.instructors()).data;
    expect(d).toMatchObject({
      neverRecorded: true,
      recordedCount: 0,
      missedCount: 4,
      avgLagDays: null,
      lastRecorded: null,
      students: 9,
    });
    expect(d.sessions).toHaveLength(4);
  });

  it('puts the worst first: most missed, then slowest', async () => {
    const { service } = build([
      // Perfect
      ...DAYS.map((d) => row('ok', 'أ. عبد الرحمن', d, { recordedAt: `${d}T16:00`, lag: 0 })),
      // Records everything, but always two days late
      ...DAYS.map((d) => row('slow', 'أ. أيمن', d, { recordedAt: `${d}T16:00`, lag: 2 })),
      // Never records
      ...DAYS.map((d) => row('never', 'أ. طارق', d)),
      // Missed two
      row('two', 'أ. ياسر', DAYS[0], { recordedAt: `${DAYS[0]}T16:00`, lag: 0 }),
      row('two', 'أ. ياسر', DAYS[1]),
      row('two', 'أ. ياسر', DAYS[2]),
      row('two', 'أ. ياسر', DAYS[3], { recordedAt: `${DAYS[3]}T16:00`, lag: 0 }),
    ]);
    const res = await service.instructors();
    expect(res.data.map((d) => d.instructorId)).toEqual([
      'never', // 4 missed
      'two', // 2 missed
      'slow', // none missed, but 2 days late on average
      'ok',
    ]);
  });

  it('summarises the last session for the top of the screen', async () => {
    const { service } = build([
      ...DAYS.map((d) => row('a', 'أ. أ', d, { recordedAt: `${d}T16:00`, lag: 0 })),
      ...DAYS.map((d) => row('b', 'أ. ب', d, { recordedAt: `${d}T16:00`, lag: 1 })),
      ...DAYS.map((d) => row('c', 'أ. ج', d)),
    ]);
    const res = await service.instructors();
    expect(res.lastSession).toBe('2026-10-17');
    expect(res.summary).toEqual({
      halaqas: 3,
      recorded: 2,
      notRecorded: 1,
      covered: 0,
      sameDay: 1,
      late: 1,
      neverRecorded: 1,
    });
  });

  it('never judges today: a Saturday morning is not a missed Saturday', async () => {
    const { service, prisma, stats } = build([]);
    // Saturday 24/10 at 10 am: the session has not happened yet.
    stats.courseContext.mockResolvedValue({
      term: { id: 24, name: 'winter-2026-2027', nameAr: 'الدورة الشتوية', startDate: '2026-09-01', endDate: null },
      meetingDays: { required: [6], optional: [4], source: 'COURSE' },
      measuredUntil: '2026-10-24',
      windowStart: '2026-09-26',
      today: '2026-10-24',
      lastRequired: { scheduled: '2026-10-24', withRecords: '2026-10-17' },
    });
    const res = await service.instructors(undefined, 4);
    expect(res.days).toEqual(['2026-09-26', '2026-10-03', '2026-10-10', '2026-10-17']);
    expect(prisma.$queryRawUnsafe.mock.calls[0][2]).toBe('2026-10-17');
  });

  it('judges up to the last day of a course that has ended', async () => {
    const { service, stats } = build([]);
    stats.courseContext.mockResolvedValue({
      term: { id: 20, name: 'summer-2026', nameAr: 'الصيفية', startDate: '2026-06-01', endDate: '2026-08-29' },
      meetingDays: { required: [6, 1, 3], optional: [], source: 'COURSE' },
      measuredUntil: '2026-08-29',
      windowStart: '2026-08-01',
      today: '2026-10-24',
      lastRequired: { scheduled: '2026-08-29', withRecords: '2026-08-29' },
    });
    const res = await service.instructors(undefined, 3);
    // Summer: Saturday, Monday, Wednesday — the last three up to 29/8.
    expect(res.days).toEqual(['2026-08-24', '2026-08-26', '2026-08-29']);
  });

  it('reports nothing to answer for when the course has no meeting days', async () => {
    const { service, prisma, stats } = build([]);
    stats.courseContext.mockResolvedValue({
      term: { id: 9, name: 'old', nameAr: 'قديمة', startDate: '2026-01-01', endDate: null },
      meetingDays: { required: [], optional: [], source: 'COURSE' },
      measuredUntil: '2026-10-17',
      windowStart: '2026-09-19',
      today: '2026-10-21',
      lastRequired: { scheduled: null, withRecords: null },
    });
    const res = await service.instructors();
    expect(res.days).toEqual([]);
    expect(res.lastSession).toBeNull();
    expect(res.data).toEqual([]);
    // No day list means no query at all, rather than a query over everything.
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('SupervisorService.instructor', () => {
  it('returns his days newest first, optional days included but never missed', async () => {
    const { service } = build([
      row('i1', 'أ. نور', '2026-10-15', { students: 11 }), // Thursday, optional
      row('i1', 'أ. نور', '2026-10-17', { recordedAt: '2026-10-17T16:00', lag: 0, students: 11 }),
    ]);
    const res = await service.instructor('i1');
    expect(res.discipline!.sessions[0].date).toBe('2026-10-17');
    const thursday = res.discipline!.sessions.find((s) => s.date === '2026-10-15')!;
    expect(thursday.kind).toBe('OPTIONAL');
    // Nobody is counted absent on a Thursday, so not recording one is not a
    // failure to record a session.
    expect(thursday.missed).toBe(false);
    expect(res.discipline!.missedCount).toBe(0);
  });

  it('returns no discipline block for a حلقة that is not in the course', async () => {
    const { service } = build([]);
    const res = await service.instructor('nobody');
    expect(res.discipline).toBeNull();
  });
});

describe('SupervisorService.day', () => {
  it('lists every حلقة of the day, unrecorded first, with the recording time', async () => {
    const { service, stats } = build([
      row('late', 'أ. ياسر', '2026-10-17'),
      row('ok', 'أ. نور', '2026-10-17', { recordedAt: '2026-10-17T16:40', lag: 0 }),
    ]);
    stats.day.mockResolvedValue({
      date: '2026-10-17',
      kind: 'REQUIRED',
      halaqas: [
        {
          instructorId: 'ok',
          instructorName: 'أ. نور',
          present: 9,
          late: 0,
          absent: 2,
          excused: 0,
          unmarked: 0,
          coveredBy: [],
          roster: [],
        },
      ],
    });
    const res = await service.day('2026-10-17');
    expect(res.halaqas.map((h) => h.instructorId)).toEqual(['late', 'ok']);
    expect(res.halaqas[0]).toMatchObject({ recorded: false, unmarked: 10 });
    expect(res.halaqas[1]).toMatchObject({
      recorded: true,
      recordedAt: '2026-10-17T16:40',
      lagDays: 0,
      present: 9,
      absent: 2,
    });
  });

  it('says so instead of failing when the course has no recorded session', async () => {
    const { service, stats } = build([]);
    stats.courseContext.mockResolvedValue({
      term: { id: 24, name: 'w', nameAr: 'شتوية', startDate: '2026-09-01', endDate: null },
      meetingDays: { required: [6], optional: [4], source: 'COURSE' },
      measuredUntil: '2026-10-17',
      windowStart: '2026-09-19',
      today: '2026-10-21',
      lastRequired: { scheduled: '2026-10-17', withRecords: null },
    });
    await expect(service.day(undefined)).resolves.toMatchObject({
      date: null,
      halaqas: [],
    });
  });

  it('refuses a date that is not a calendar day', async () => {
    const { service } = build([]);
    await expect(service.day('17-10-2026')).rejects.toThrow(/غير صالح/);
  });
});
