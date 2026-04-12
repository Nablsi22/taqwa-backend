import * as path from 'path';
import * as fs from 'fs';

// ═══════════════════════════════════════════════════════════════
// Quran Ayat → Pages Utility (Madinah Mushaf, Hafs riwaya)
// Loads quran_ayat_pages.json from quran-meta v6.0.17.
// ═══════════════════════════════════════════════════════════════

interface SurahJsonEntry {
  n: number;       // surah number 1..114
  name: string;    // Arabic name (UTF-8)
  numAyas: number;
  firstAyahId: number;
  juzStart: number;
}

interface QuranJson {
  meta: {
    riwaya: string;
    mushaf: string;
    numSurahs: number;
    numAyas: number;
    numPages: number;
  };
  surahs: SurahJsonEntry[];
  pageStarts: number[];
  /** ayaToPage[surahIndex][ayaIndex] = page number. Both indexes are 0-based. */
  ayaToPage: number[][];
}

interface SurahMeta {
  number: number;
  nameAr: string;
  numAyas: number;
  totalPages: number;
  startPage: number;
  endPage: number;
}

const TOTAL_QURAN_PAGES = 604;

// ─── Load JSON once at module init ───
function loadQuranJson(): QuranJson {
  const candidates = [
    path.join(__dirname, 'quran_ayat_pages.json'),
    path.join(process.cwd(), 'src', 'quran-metadata', 'quran_ayat_pages.json'),
    path.join(process.cwd(), 'dist', 'quran-metadata', 'quran_ayat_pages.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      return JSON.parse(raw);
    }
  }
  throw new Error(
    'quran_ayat_pages.json not found. Expected at backend/src/quran-metadata/',
  );
}

const QURAN: QuranJson = loadQuranJson();

// ─── Build per-surah meta with computed page ranges ───
const SURAH_META_BY_NUMBER = new Map<number, SurahMeta>();

for (const s of QURAN.surahs) {
  const ayaPages = QURAN.ayaToPage[s.n - 1];
  if (!ayaPages || ayaPages.length === 0) continue;

  let minPage = ayaPages[0];
  let maxPage = ayaPages[0];
  for (const p of ayaPages) {
    if (p < minPage) minPage = p;
    if (p > maxPage) maxPage = p;
  }

  SURAH_META_BY_NUMBER.set(s.n, {
    number: s.n,
    nameAr: s.name,
    numAyas: s.numAyas,
    startPage: minPage,
    endPage: maxPage,
    totalPages: maxPage - minPage + 1,
  });
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

export function getPageForAya(surah: number, aya: number): number | null {
  if (surah < 1 || surah > 114) return null;
  const ayaPages = QURAN.ayaToPage[surah - 1];
  if (!ayaPages || aya < 1 || aya > ayaPages.length) return null;
  return ayaPages[aya - 1];
}

export function getSurahMeta(surah: number): SurahMeta | null {
  return SURAH_META_BY_NUMBER.get(surah) ?? null;
}

export function getAllSurahs(): SurahMeta[] {
  const list: SurahMeta[] = [];
  for (let i = 1; i <= 114; i++) {
    const m = SURAH_META_BY_NUMBER.get(i);
    if (m) list.push(m);
  }
  return list;
}

/**
 * Validate an aya range. Single-surah only.
 */
export function validateRange(
  startSurah: number,
  startAya: number,
  endSurah: number,
  endAya: number,
): { valid: boolean; error?: string } {
  if (startSurah !== endSurah) {
    return { valid: false, error: 'يُسمح فقط بنطاق ضمن سورة واحدة' };
  }
  const meta = getSurahMeta(startSurah);
  if (!meta) return { valid: false, error: `سورة غير صالحة: ${startSurah}` };
  if (startAya < 1 || startAya > meta.numAyas) {
    return { valid: false, error: 'آية البداية غير صالحة' };
  }
  if (endAya < startAya || endAya > meta.numAyas) {
    return { valid: false, error: 'آية النهاية غير صالحة' };
  }
  return { valid: true };
}

/**
 * Calculate the exact page count for an aya range (single-surah only).
 *
 * Algorithm: For every page the range touches, count how many ayas
 * (from ANY surah) live on that page, and how many of OUR ayas live
 * on that page. The page's contribution to the total is
 * (ourAyas / totalAyasOnPage). Sum across all touched pages.
 *
 * Verified outputs (Madinah Mushaf):
 *   • Full النبأ  (78:1–40)  → 1.4 pages
 *   • الفاتحة     (1:1–7)    → 1.0 page
 *   • القدر       (97:1–5)   → 0.42 pages
 */
export function calculatePages(
  startSurah: number,
  startAya: number,
  endSurah: number,
  endAya: number,
): number {
  if (startSurah !== endSurah) return 0;
  const ourAyaPages = QURAN.ayaToPage[startSurah - 1];
  if (!ourAyaPages) return 0;
  if (startAya < 1 || endAya > ourAyaPages.length || endAya < startAya) {
    return 0;
  }

  // Pages our range actually touches, mapped to how many of our ayas land there
  const ourAyasPerPage = new Map<number, number>();
  for (let a = startAya; a <= endAya; a++) {
    const page = ourAyaPages[a - 1];
    ourAyasPerPage.set(page, (ourAyasPerPage.get(page) ?? 0) + 1);
  }

  // For each touched page, count the TOTAL ayas on that page across all surahs
  const totalAyasPerPage = new Map<number, number>();
  for (const page of ourAyasPerPage.keys()) totalAyasPerPage.set(page, 0);

  for (let surahIdx = 0; surahIdx < QURAN.ayaToPage.length; surahIdx++) {
    const ayaPages = QURAN.ayaToPage[surahIdx];
    for (const page of ayaPages) {
      if (totalAyasPerPage.has(page)) {
        totalAyasPerPage.set(page, totalAyasPerPage.get(page)! + 1);
      }
    }
  }

  let total = 0;
  for (const [page, ours] of ourAyasPerPage) {
    const totalOnPage = totalAyasPerPage.get(page) ?? ours;
    if (totalOnPage > 0) total += ours / totalOnPage;
  }

  return Math.round(total * 1000) / 1000;
}

export function getRangePages(
  startSurah: number,
  startAya: number,
  endSurah: number,
  endAya: number,
): number {
  return calculatePages(startSurah, startAya, endSurah, endAya);
}

/**
 * Points formula:
 *   pages < 5, VERY_GOOD       → 2.0 × pages
 *   pages < 5, GOOD            → 1.0 × pages
 *   pages ≥ 5, VERY_GOOD/GOOD  → 3.0 × pages
 *   REPEAT / DID_NOT_MEMORIZE / MAQRAA → 0
 */
export function calculatePoints(pages: number, rating: string): number {
  if (!pages || pages <= 0) return 0;
  if (
    rating === 'REPEAT' ||
    rating === 'DID_NOT_MEMORIZE' ||
    rating === 'MAQRAA'
  ) {
    return 0;
  }
  if (pages >= 5) {
    if (rating === 'VERY_GOOD' || rating === 'GOOD') {
      return Math.round(3 * pages * 1000) / 1000;
    }
    return 0;
  }
  if (rating === 'VERY_GOOD') return Math.round(2 * pages * 1000) / 1000;
  if (rating === 'GOOD') return Math.round(1 * pages * 1000) / 1000;
  return 0;
}

export { TOTAL_QURAN_PAGES };