import {
  addDays,
  dayKindOf,
  isCalendarDay,
  isMonth,
  isoDow,
  lastSessionDay,
  localToday,
  monthBounds,
  resolveMeetingDays,
} from './meeting-days';
import { classify } from './attendance-stats.rules';

describe('meeting-days', () => {
  describe('calendar arithmetic', () => {
    it('knows the weekdays of the winter course', () => {
      expect(isoDow('2026-09-19')).toBe(6); // Saturday — first day of winter
      expect(isoDow('2026-10-22')).toBe(4); // Thursday
      expect(isoDow('2026-10-25')).toBe(7); // Sunday
      expect(isoDow('2026-10-19')).toBe(1); // Monday
    });

    it('adds days across month and year ends', () => {
      expect(addDays('2026-10-01', -1)).toBe('2026-09-30');
      expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
      expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    });

    it('validates calendar days and months strictly', () => {
      expect(isCalendarDay('2026-10-17')).toBe(true);
      expect(isCalendarDay('2026-02-30')).toBe(false);
      expect(isCalendarDay('2026-10-7')).toBe(false);
      expect(isMonth('2026-10')).toBe(true);
      expect(isMonth('2026-13')).toBe(false);
    });

    it('gives month bounds including leap February', () => {
      expect(monthBounds('2026-10')).toEqual({
        first: '2026-10-01',
        last: '2026-10-31',
      });
      expect(monthBounds('2028-02')).toEqual({
        first: '2028-02-01',
        last: '2028-02-29',
      });
    });

    it('computes today in Damascus regardless of the server time zone', () => {
      // 2026-10-17 21:30 UTC is already Sunday 00:30 in Damascus (UTC+03:00)
      expect(
        localToday('Asia/Damascus', new Date('2026-10-17T21:30:00Z')),
      ).toBe('2026-10-18');
      expect(
        localToday('Asia/Damascus', new Date('2026-10-17T20:59:59Z')),
      ).toBe('2026-10-17');
    });
  });

  describe('day kinds', () => {
    const winter = { required: [6], optional: [4] } as const;
    it('classifies winter days', () => {
      expect(dayKindOf('2026-10-17', winter)).toBe('REQUIRED');
      expect(dayKindOf('2026-10-15', winter)).toBe('OPTIONAL');
      expect(dayKindOf('2026-10-18', winter)).toBe('EXTRA'); // a Sunday record
    });
  });

  describe('resolveMeetingDays', () => {
    it('uses the course configuration when present', () => {
      expect(
        resolveMeetingDays({ requiredDays: [6], optionalDays: [4] }, []),
      ).toEqual({
        required: [6],
        optional: [4],
        source: 'COURSE',
      });
    });
    it('drops invalid values and an optional day that is also required', () => {
      expect(
        resolveMeetingDays(
          { requiredDays: [6, 6, 9], optionalDays: [6, 4, 0] },
          [],
        ),
      ).toEqual({
        required: [6],
        optional: [4],
        source: 'COURSE',
      });
    });
    it('infers required days (>= 10 % of session days) for an unconfigured course', () => {
      const observed = [
        { isodow: 6, days: 14 },
        { isodow: 1, days: 13 },
        { isodow: 3, days: 12 },
        { isodow: 5, days: 3 }, // 3/42 ≈ 7 % → not a meeting day
      ];
      expect(
        resolveMeetingDays({ requiredDays: [], optionalDays: [] }, observed),
      ).toEqual({
        required: [1, 3, 6],
        optional: [],
        source: 'INFERRED',
      });
    });
  });

  describe('lastSessionDay («آخر يوم دوام»)', () => {
    const recorded = new Set(['2026-10-15', '2026-10-17']);

    it('on Tuesday of a winter week, winter → previous Saturday', () => {
      expect(lastSessionDay('2026-10-20', '2026-09-19', [6], recorded)).toEqual(
        {
          scheduled: '2026-10-17',
          withRecords: '2026-10-17',
        },
      );
    });
    it('a meeting day with nothing recorded yet does not count as today', () => {
      expect(lastSessionDay('2026-10-24', '2026-09-19', [6], recorded)).toEqual(
        {
          scheduled: '2026-10-17',
          withRecords: '2026-10-17',
        },
      );
    });
    it('today counts once recording has started', () => {
      expect(
        lastSessionDay(
          '2026-10-24',
          '2026-09-19',
          [6],
          new Set([...recorded, '2026-10-24']),
        ),
      ).toEqual({
        scheduled: '2026-10-24',
        withRecords: '2026-10-24',
      });
    });
    it('reports an unrecorded past meeting day and falls back to the recorded one before it', () => {
      expect(lastSessionDay('2026-10-26', '2026-09-19', [6], recorded)).toEqual(
        {
          scheduled: '2026-10-24',
          withRecords: '2026-10-17',
        },
      );
    });
    it('summer: Tuesday → Monday', () => {
      expect(
        lastSessionDay(
          '2026-07-14',
          '2026-06-06',
          [6, 1, 3],
          new Set(['2026-07-13']),
        ),
      ).toEqual({
        scheduled: '2026-07-13',
        withRecords: '2026-07-13',
      });
    });
    it('never walks before the course start, nor past a closed course end', () => {
      expect(
        lastSessionDay('2026-09-20', '2026-09-19', [4], new Set()),
      ).toEqual({ scheduled: null, withRecords: null });
      expect(
        lastSessionDay(
          '2026-10-21',
          '2026-06-06',
          [6],
          new Set(['2026-09-12', '2026-10-17']),
          '2026-09-18',
        ),
      ).toEqual({
        scheduled: '2026-09-12',
        withRecords: '2026-09-12',
      });
    });
    it('no meeting days → nothing', () => {
      expect(lastSessionDay('2026-10-21', '2026-09-19', [], recorded)).toEqual({
        scheduled: null,
        withRecords: null,
      });
    });
  });

  describe('classify (ثابت / متذبذب / منقطع)', () => {
    it('applies the agreed counts', () => {
      expect(classify(0, 0)).toBe('NO_DATA');
      expect(classify(4, 0)).toBe('INACTIVE');
      expect(classify(4, 4)).toBe('REGULAR');
      expect(classify(4, 3)).toBe('REGULAR'); // missed one
      expect(classify(4, 2)).toBe('IRREGULAR'); // missed two
      expect(classify(1, 1)).toBe('REGULAR'); // joined this week
    });
  });
});
