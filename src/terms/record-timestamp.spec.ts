import { BadRequestException } from '@nestjs/common';
import { TermsService } from './terms.service';

// «تاريخ التسجيل» for manual points and Nawawi hadith.
// Now: Friday 30 Oct 2026, 14:05:09 in Damascus (UTC+03:00).
const NOW = new Date('2026-10-30T11:05:09.000Z');

function buildService(activeTerm: { nameAr: string; startDate: Date } | null) {
  const prisma: any = {
    term: { findFirst: jest.fn(async () => activeTerm) },
  };
  return new TermsService(prisma);
}

const WINTER = {
  nameAr: 'الدورة الشتوية',
  startDate: new Date('2026-09-19T00:00:00.000Z'),
};

describe('TermsService.resolveRecordTimestamp', () => {
  beforeEach(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(NOW);
  });
  afterEach(() => jest.useRealTimers());

  it.each([undefined, null, ''])('keeps the DB default for %p', async (day) => {
    await expect(
      buildService(WINTER).resolveRecordTimestamp(day),
    ).resolves.toBeUndefined();
  });

  it('keeps the DB default for today', async () => {
    await expect(
      buildService(WINTER).resolveRecordTimestamp('2026-10-30'),
    ).resolves.toBeUndefined();
  });

  it('stamps an earlier day at the current Damascus time of day', async () => {
    const stamped =
      await buildService(WINTER).resolveRecordTimestamp('2026-10-24');
    expect(stamped?.toISOString()).toBe('2026-10-24T11:05:09.000Z');
  });

  it('accepts the first day of the active course', async () => {
    const stamped =
      await buildService(WINTER).resolveRecordTimestamp('2026-09-19');
    expect(stamped?.toISOString()).toBe('2026-09-19T11:05:09.000Z');
  });

  it('refuses a day before the active course started', async () => {
    await expect(
      buildService(WINTER).resolveRecordTimestamp('2026-09-18'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses a future day', async () => {
    await expect(
      buildService(WINTER).resolveRecordTimestamp('2026-10-31'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['2026-02-30', '30-10-2026', 'yesterday'])(
    'refuses malformed %p',
    async (day) => {
      await expect(
        buildService(WINTER).resolveRecordTimestamp(day),
      ).rejects.toBeInstanceOf(BadRequestException);
    },
  );

  it('refuses a past day when no course is active', async () => {
    await expect(
      buildService(null).resolveRecordTimestamp('2026-10-24'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
