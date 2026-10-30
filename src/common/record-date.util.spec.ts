import {
  composeRecordTimestamp,
  parseCalendarDay,
  timeZoneOffsetMs,
} from './record-date.util';

describe('record-date.util', () => {
  describe('parseCalendarDay', () => {
    it('accepts a real calendar day', () => {
      expect(parseCalendarDay('2026-10-24')).toEqual({
        year: 2026,
        month: 10,
        day: 24,
      });
    });

    it.each(['2026-02-30', '2026-13-01', '2026-1-5', '24-10-2026', '', 'x'])(
      'rejects %p',
      (value) => {
        expect(parseCalendarDay(value)).toBeNull();
      },
    );
  });

  describe('timeZoneOffsetMs', () => {
    it('reads Damascus as UTC+03:00', () => {
      const at = new Date('2026-10-30T11:05:09.123Z');
      expect(timeZoneOffsetMs(at, 'Asia/Damascus')).toBe(3 * 60 * 60 * 1000);
    });

    it('reads UTC as zero', () => {
      expect(timeZoneOffsetMs(new Date(), 'UTC')).toBe(0);
    });
  });

  describe('composeRecordTimestamp', () => {
    it('keeps the current Damascus time of day on the chosen day', () => {
      const now = new Date('2026-10-30T11:05:09.123Z'); // 14:05:09 Damascus
      expect(
        composeRecordTimestamp(
          '2026-10-24',
          'Asia/Damascus',
          now,
        ).toISOString(),
      ).toBe('2026-10-24T11:05:09.123Z');
    });

    it('stays on the chosen Damascus day just after local midnight', () => {
      // 00:30 on 31 Oct in Damascus is still 30 Oct in UTC.
      const now = new Date('2026-10-30T21:30:00.000Z');
      const stamped = composeRecordTimestamp(
        '2026-10-25',
        'Asia/Damascus',
        now,
      );
      expect(stamped.toISOString()).toBe('2026-10-24T21:30:00.000Z');
      expect(
        new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Damascus' }).format(
          stamped,
        ),
      ).toBe('2026-10-25');
    });

    it('throws on a malformed day', () => {
      expect(() =>
        composeRecordTimestamp('2026-02-30', 'Asia/Damascus'),
      ).toThrow();
    });
  });
});
