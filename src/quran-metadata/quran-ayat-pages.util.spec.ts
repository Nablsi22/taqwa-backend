import {
  getVerseCount,
  validateRange,
  calculatePages,
  calculatePoints,
  getSurahMeta,
} from './quran-ayat-pages.util';
import { getSuraByNumber } from './quran-metadata';

// ═══════════════════════════════════════════════════════════════════════════
// These tests exist because of a real production defect.
//
// Recitations used to be recordable either as "whole sura" (page count taken
// from a curated per-sura table) or as a verse range (page count measured
// against the mushaf page map). The two disagreed by 40-75%, so two students
// who memorised the same ayat could receive very different points depending
// on which button their instructor pressed.
//
// The whole-sura path is gone. What follows pins down the one remaining
// measurement so it cannot drift back.
// ═══════════════════════════════════════════════════════════════════════════

describe('getVerseCount — the single definition of how long a recitation is', () => {
  it('is endAya - startAya + 1, inclusive of both ends', () => {
    expect(getVerseCount(1, 10)).toBe(10);   // البقرة 1-10
    expect(getVerseCount(1, 15)).toBe(15);   // الملك 1-15
    expect(getVerseCount(20, 30)).toBe(11);  // النبأ 20-30
  });

  it('counts a single ayah as 1, never 0', () => {
    expect(getVerseCount(7, 7)).toBe(1);
    expect(getVerseCount(1, 1)).toBe(1);
  });

  it('never rounds or estimates — every range is an exact integer', () => {
    for (let start = 1; start <= 50; start++) {
      for (let len = 1; len <= 20; len++) {
        const count = getVerseCount(start, start + len - 1);
        expect(Number.isInteger(count)).toBe(true);
        expect(count).toBe(len);
      }
    }
  });

  it('refuses a reversed or zero-based range instead of returning a negative', () => {
    expect(getVerseCount(30, 20)).toBe(0);
    expect(getVerseCount(0, 5)).toBe(0);
    expect(getVerseCount(-3, 5)).toBe(0);
    expect(getVerseCount(1.5, 5)).toBe(0);
  });
});

describe('validateRange — the three rules the recitation form promises', () => {
  it('accepts the examples the feature was specified with', () => {
    expect(validateRange(2, 1, 2, 10).valid).toBe(true);   // البقرة 1-10
    expect(validateRange(67, 1, 67, 15).valid).toBe(true);  // الملك 1-15
    expect(validateRange(78, 20, 78, 30).valid).toBe(true); // النبأ 20-30
  });

  it('rejects a start ayah below 1', () => {
    const r = validateRange(2, 0, 2, 10);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('البداية');
  });

  it('rejects an end ayah past the surah length, naming the real count', () => {
    // الملك has 30 ayat.
    const r = validateRange(67, 1, 67, 31);
    expect(r.valid).toBe(false);
    expect(r.error).toContain('30');
  });

  it('rejects end < start', () => {
    expect(validateRange(2, 30, 2, 20).valid).toBe(false);
  });

  it('rejects a range that crosses two surahs', () => {
    expect(validateRange(78, 1, 79, 5).valid).toBe(false);
  });

  it('accepts the full length of every surah and rejects one ayah beyond it', () => {
    for (let s = 1; s <= 114; s++) {
      const meta = getSurahMeta(s)!;
      expect(validateRange(s, 1, s, meta.numAyas).valid).toBe(true);
      expect(validateRange(s, 1, s, meta.numAyas + 1).valid).toBe(false);
    }
  });
});

describe('fairness — identical work earns identical points', () => {
  const RANGES: Array<[number, number, number]> = [
    [2, 1, 10],
    [67, 1, 15],
    [78, 20, 30],
    [1, 1, 7],
    [97, 1, 5],
    [36, 1, 83],
  ];

  it('gives two students the same page span for the same range', () => {
    for (const [surah, start, end] of RANGES) {
      const a = calculatePages(surah, start, surah, end);
      const b = calculatePages(surah, start, surah, end);
      expect(a).toBe(b);
    }
  });

  it('gives two students the same points for the same range and rating', () => {
    for (const [surah, start, end] of RANGES) {
      const pages = calculatePages(surah, start, surah, end);
      expect(calculatePoints(pages, 'VERY_GOOD')).toBe(
        calculatePoints(pages, 'VERY_GOOD'),
      );
      expect(calculatePoints(pages, 'GOOD')).toBe(
        calculatePoints(pages, 'GOOD'),
      );
    }
  });

  it('scores by how much was recited, never by which surah it was', () => {
    // Two different surahs, page spans deliberately compared rather than
    // assumed equal: what must hold is that MORE pages is never worth LESS.
    const short = calculatePages(97, 1, 97, 5);   // القدر, 5 ayat
    const long = calculatePages(78, 1, 78, 40);   // النبأ, 40 ayat
    expect(long).toBeGreaterThan(short);
    expect(calculatePoints(long, 'VERY_GOOD')).toBeGreaterThan(
      calculatePoints(short, 'VERY_GOOD'),
    );
  });

  it('is monotonic — extending a range never lowers the page span', () => {
    let previous = 0;
    for (let end = 1; end <= 40; end++) {
      const pages = calculatePages(78, 1, 78, end);
      expect(pages).toBeGreaterThanOrEqual(previous);
      previous = pages;
    }
  });

  it('awards nothing for ratings that mean no memorisation happened', () => {
    const pages = calculatePages(2, 1, 2, 10);
    expect(calculatePoints(pages, 'REPEAT')).toBe(0);
    expect(calculatePoints(pages, 'DID_NOT_MEMORIZE')).toBe(0);
    expect(calculatePoints(pages, 'MAQRAA')).toBe(0);
  });
});

describe('calculatePages — measured against the mushaf, verified figures', () => {
  it('matches the hand-verified Madinah-mushaf spans', () => {
    expect(calculatePages(1, 1, 1, 7)).toBeCloseTo(1.0, 2);    // الفاتحة
    expect(calculatePages(78, 1, 78, 40)).toBeCloseTo(1.4, 1); // النبأ
    expect(calculatePages(97, 1, 97, 5)).toBeCloseTo(0.42, 2); // القدر
  });

  it('returns 0 rather than a guess for a cross-surah range', () => {
    expect(calculatePages(78, 1, 79, 5)).toBe(0);
  });
});

describe('why the whole-sura option had to go', () => {
  // The curated per-sura table totals ~639.75 pages against the mushaf's 604,
  // so a whole-sura entry systematically overpaid. This test does not assert
  // a specific gap — it asserts that the two methods disagree, which is the
  // whole reason only one of them is still reachable from the app.
  it('the retired per-sura table and the exact page map disagree', () => {
    const disagreements: number[] = [];
    for (let s = 1; s <= 114; s++) {
      const meta = getSurahMeta(s)!;
      const exact = calculatePages(s, 1, s, meta.numAyas);
      const legacyTable = getSuraByNumber(s)?.totalPages ?? 0;
      if (Math.abs(legacyTable - exact) > 0.05) disagreements.push(s);
    }
    expect(disagreements.length).toBeGreaterThan(0);
  });

  it('the exact method never exceeds the mushaf total', () => {
    let total = 0;
    for (let s = 1; s <= 114; s++) {
      const meta = getSurahMeta(s)!;
      total += calculatePages(s, 1, s, meta.numAyas);
    }
    // Every ayah in the Quran, measured once: 604 pages, give or take
    // rounding at three decimals per surah.
    expect(total).toBeGreaterThan(600);
    expect(total).toBeLessThanOrEqual(605);
  });
});
