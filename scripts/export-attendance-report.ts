/**
 * ---------------------------------------------------------------------------
 *  التقرير الشامل للطلاب — تصدير إلى ملف Excel
 * ---------------------------------------------------------------------------
 *  ورقة واحدة تجمع كل تفاصيل الطالب: الحضور والحفظ والأجزاء والأحاديث
 *  واللباس الأنيق والسبر بالأوقاف.
 *
 *  ــ الحضور ــ
 *  أيام الدوام الرسمية : السبت، الاثنين، الأربعاء فقط
 *                        (الحصص الإضافية مستبعدة حضوراً وغياباً معاً)
 *  احتساب الحضور       : PRESENT + LATE (المتأخر يُحتسب حاضراً)
 *  مقام النسبة         : أيام الدوام الواقعة بعد تاريخ تسجيل الطالب
 *
 *  ــ المدى الزمني ــ
 *  ضمن الفترة  : الحضور، الغياب، اللباس الأنيق
 *  تراكمي      : الصفحات، الأجزاء، الأحاديث، السبر بالأوقاف
 *                (الحفظ رصيد لا نشاط دوري)
 *
 *  ــ الأجزاء ــ
 *  الجزء يُعدّ محفوظاً إذا سُمِّعت كل صفحاته دون استثناء.
 *  تُشتق الصفحات من startPage/endPage؛ التسميعات التي تركتهما فارغين
 *  لا تدخل حساب الأجزاء (لكنها تدخل حساب الصفحات).
 *
 *  التشغيل:
 *    $cred = Get-Credential -UserName db -Message 'Paste DATABASE_URL as password'
 *    $env:DATABASE_URL = $cred.GetNetworkCredential().Password
 *    npx ts-node -P tsconfig.json scripts/export-attendance-report.ts
 *    Remove-Item Env:\DATABASE_URL; Remove-Variable cred
 *
 *  ملاحظة: هذا السكربت للقراءة فقط. لا يحتوي أي INSERT / UPDATE / DELETE.
 * ---------------------------------------------------------------------------
 */

import { Prisma, PrismaClient } from '@prisma/client';
import ExcelJS from 'exceljs';
import * as fs from 'node:fs';
import * as path from 'node:path';

/* ===========================================================================
 *  الأنواع
 * ======================================================================== */

type StudentStatus = 'نشط' | 'منقطع' | 'جديد' | 'بلا تسجيل';

interface ReportRow {
  student_id: string;
  seq: number;
  full_name: string;
  father_name: string | null;
  school: string | null;
  grade: string | null;
  age: number | null;
  instructor_name: string | null;
  registered_on: Date | null;
  status_label: StudentStatus;
  last_seen: Date | null;
  eligible_days: number;
  attended_days: number;
  late_days: number;
  absent_days: number;
  unrecorded_days: number;
  attendance_rate: number | null;
  pages_memorized: number;
  juz_count: number;
  juz_list: string | null;
  hadith_count: number;
  neat_dress_count: number;
  awkaf_level: number;
  total_points: number;
}

interface SessionDayRow {
  session_date: Date;
}

interface DiagnosticsRow {
  official_rows: number;
  offday_rows: number;
  offday_days: number;
  awkaf_rows: number;
  recitations_total: number;
  recitations_without_pages: number;
}

/* ===========================================================================
 *  الإعدادات
 * ======================================================================== */

const CONFIG = {
  outputDir: path.resolve(process.cwd(), 'exports'),

  /** بداية المجال الزمني — صيغة YYYY-MM-DD (شاملة) */
  dateFrom: '2026-06-06',

  /** نهاية المجال الزمني — صيغة YYYY-MM-DD (شاملة) */
  dateTo: '2026-08-19',

  /** أقل من هذا العدد من الأيام المؤهَّلة ⟵ «جديد»، والنسبة تُترك فارغة */
  newStudentMaxDays: 5,

  /** عدم الظهور لأكثر من هذا العدد من الأيام ⟵ «منقطع» */
  inactiveAfterDays: 21,

  /**
   * الورقة المصفّاة: الحد الأدنى لأيام الحضور الفعلي (حضور + تأخير).
   * غيّرها إلى 'eligible' في filteredBasis أدناه لتصفية بالأيام المؤهَّلة بدل الحضور.
   */
  filteredMinDays: 7,

  /** أساس التصفية: 'attended' = أيام الحضور الفعلي، 'eligible' = الأيام المؤهَّلة */
  filteredBasis: 'attended' as 'attended' | 'eligible',

  /** يُلوَّن صف الطالب النشط بالأحمر الفاتح تحت هذه النسبة */
  lowAttendanceThreshold: 60,

  /** يُلوَّن صف الطالب النشط بالأصفر الفاتح تحت هذه النسبة */
  warningAttendanceThreshold: 75,

  /** عدد أحاديث الأربعين النووية كاملة — يُبرَز الطالب عند بلوغه */
  hadithTotal: 42,

  /**
   * التقديرات التي تُعدّ حفظاً. قائمة إيجابية عن قصد: أي تقدير جديد
   * يُضاف للنظام مستقبلاً لن يدخل الحساب تلقائياً.
   * المستبعد: REPEAT (إعادة)، MAQRAA (مقرأة جماعية)، DID_NOT_MEMORIZE (لم يحفظ).
   */
  memorizedRatings: ['VERY_GOOD', 'GOOD'] as const,

  /** خط عربي متوفر افتراضياً في Excel على Windows */
  fontName: 'Arial',
} as const;

const PALETTE = {
  domeBlue: 'FF1B4F72',
  minaretGold: 'FFD4AC0D',
  islamicGreen: 'FF1E8449',
  skyBlue: 'FF2E86C1',
  danger: 'FFC0392B',
  headerText: 'FFFFFFFF',
  bandFill: 'FFF4F6F7',
  dangerFill: 'FFFADBD8',
  warningFill: 'FFFCF3CF',
  neutralFill: 'FFEBF5FB',
  mutedFill: 'FFE5E7E9',
  groupAttendance: 'FF1B4F72',
  groupMemorization: 'FF1E8449',
  groupConduct: 'FFD4AC0D',
  completeFill: 'FFD4AC0D',
  completeText: 'FFFFFFFF',
  border: 'FFBDC3C7',
} as const;

const STATUS_COLOR: Record<StudentStatus, string> = {
  'نشط': PALETTE.islamicGreen,
  'منقطع': PALETTE.minaretGold,
  'جديد': PALETTE.skyBlue,
  'بلا تسجيل': PALETTE.danger,
};

const ARABIC_WEEKDAYS = [
  'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت',
] as const;

/** أسماء الأجزاء بالترتيب (الفهرس 1..30) */
const JUZ_NAMES: readonly string[] = [
  '', 'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع',
  'الثامن', 'التاسع', 'العاشر', 'الحادي عشر', 'الثاني عشر', 'الثالث عشر',
  'الرابع عشر', 'الخامس عشر', 'السادس عشر', 'السابع عشر', 'الثامن عشر',
  'التاسع عشر', 'العشرون', 'الحادي والعشرون', 'الثاني والعشرون',
  'الثالث والعشرون', 'الرابع والعشرون', 'الخامس والعشرون', 'السادس والعشرون',
  'السابع والعشرون', 'الثامن والعشرون', 'التاسع والعشرون', 'الثلاثون',
];

/** تقدير السبر بالأوقاف حسب المستوى المستخرج من points_log */
const AWKAF_LABEL: Record<number, string> = {
  0: 'لا',
  1: 'نعم — جيد',
  2: 'نعم — جيد جداً',
  3: 'نعم — ممتاز',
};

/**
 * حجم الورق A3 = 8 في مواصفة OOXML.
 * تعريفات exceljs تُسقط القيمة 8 من اتحاد PaperSize سهواً (بينما تشمل 9 = A4)،
 * فيلزم تأكيد نوع مزدوج. القيمة صحيحة ويقبلها Excel بلا مشكلة.
 * المرجع: ECMA-376 Part 1, §18.3.1.63 (pageSetup@paperSize)
 */
const PAPER_SIZE_A3 = 8 as unknown as ExcelJS.PaperSize;

/* ===========================================================================
 *  أدوات مساعدة
 * ======================================================================== */

function toNum(value: unknown, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
  if (typeof value === 'bigint') return Number(value);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return new Date(value).toISOString().slice(0, 10);
}

function fileTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

/** تحويل قائمة أرقام أجزاء ('3,29,30') إلى أسماء عربية مقروءة */
function formatJuzList(raw: string | null): string {
  if (!raw) return '—';
  const names = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 30)
    .map((n) => JUZ_NAMES[n]);
  return names.length > 0 ? names.join('، ') : '—';
}

/**
 * إدراج عدد صحيح كقيمة حرفية في نص SQL.
 * السبب: Prisma يمرّر أرقام JavaScript كـ int8، وPostgres لا يعرّف
 * العامل `date - bigint`، ولا يُجدي `$1::int` لأن نوع المعامل يُحسم
 * في بروتوكول الاستعلام الممتد قبل تطبيقه.
 * الأمان: القيم ثوابت داخلية من CONFIG، والتحقق أدناه يقصرها على الأرقام.
 */
function sqlInt(value: number, label: string): Prisma.Sql {
  if (!Number.isInteger(value) || value < 0 || value > 100_000) {
    throw new Error(`قيمة غير صالحة في CONFIG.${label}: ${value}`);
  }
  return Prisma.raw(String(value));
}

/** إدراج تاريخ كقيمة حرفية في نص SQL، بتحقق نمطي صارم */
function sqlDate(value: string, label: string): Prisma.Sql {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(
      `قيمة غير صالحة في CONFIG.${label}: يجب أن تكون تاريخاً بصيغة YYYY-MM-DD (المُعطى: ${value})`,
    );
  }
  return Prisma.raw(`DATE '${value}'`);
}

if (Date.parse(CONFIG.dateFrom) > Date.parse(CONFIG.dateTo)) {
  throw new Error(
    `مجال زمني غير صالح: dateFrom (${CONFIG.dateFrom}) يتجاوز dateTo (${CONFIG.dateTo})`,
  );
}

const RANGE_FROM = sqlDate(CONFIG.dateFrom, 'dateFrom');
const RANGE_TO = sqlDate(CONFIG.dateTo, 'dateTo');
const NEW_MAX = sqlInt(CONFIG.newStudentMaxDays, 'newStudentMaxDays');
const INACTIVE_AFTER = sqlInt(CONFIG.inactiveAfterDays, 'inactiveAfterDays');

/* ===========================================================================
 *  بيانات المصحف — اشتقاق الصفحات من السورة والآية
 * ======================================================================== */

interface QuranMeta {
  meta: { numSurahs: number; numAyas: number; numPages: number };
  surahs: Array<{ n: number; name: string; numAyas: number; firstAyahId: number; juzStart: number }>;
  pageStarts: number[];
  /** ayaToPage[surah-1][aya-1] = رقم الصفحة */
  ayaToPage: number[][];
}

interface RecitationRow {
  student_id: string;
  surah_number: number | null;
  startSurah: number | null;
  startAya: number | null;
  endSurah: number | null;
  endAya: number | null;
  is_complete_sura: boolean | null;
}

/** حدود أجزاء المصحف المدني بالصفحات — المجموع 604 */
const JUZ_PAGES: ReadonlyArray<readonly [number, number]> = [
  [1, 21], [22, 41], [42, 61], [62, 81], [82, 101], [102, 121],
  [122, 141], [142, 161], [162, 181], [182, 201], [202, 221], [222, 241],
  [242, 261], [262, 281], [282, 301], [302, 321], [322, 341], [342, 361],
  [362, 381], [382, 401], [402, 421], [422, 441], [442, 461], [462, 481],
  [482, 501], [502, 521], [522, 541], [542, 561], [562, 581], [582, 604],
];

function loadQuranMeta(): QuranMeta {
  const candidates = [
    path.resolve(process.cwd(), 'src', 'quran-metadata', 'quran_ayat_pages.json'),
    path.resolve(process.cwd(), 'dist', 'quran-metadata', 'quran_ayat_pages.json'),
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as QuranMeta;
    if (!Array.isArray(parsed.ayaToPage) || parsed.ayaToPage.length !== 114) {
      throw new Error(`بنية غير متوقَّعة في ${candidate}: ayaToPage يجب أن تحوي 114 مصفوفة`);
    }
    console.log(`  ملف المصحف: ${candidate}`);
    return parsed;
  }

  throw new Error(
    'لم يُعثر على quran_ayat_pages.json في src/quran-metadata أو dist/quran-metadata. '
      + 'شغّل السكربت من جذر مجلد backend.',
  );
}

/** أرقام الصفحات التي يغطّيها تسميع واحد (قد تتكرر؛ التجميع يزيل التكرار) */
function pagesForRecitation(meta: QuranMeta, r: RecitationRow): number[] {
  const out: number[] = [];

  // سورة كاملة: كل صفحاتها
  if (r.is_complete_sura === true && r.surah_number) {
    const table = meta.ayaToPage[r.surah_number - 1];
    if (table) out.push(...table);
    return out;
  }

  // نطاق آيات: من سورة/آية البداية إلى سورة/آية النهاية
  const { startSurah: s1, startAya: a1, endSurah: s2, endAya: a2 } = r;
  if (!s1 || !a1 || !s2 || !a2 || s2 < s1) return out;

  for (let surah = s1; surah <= s2 && surah <= 114; surah += 1) {
    const table = meta.ayaToPage[surah - 1];
    if (!table) continue;

    const from = surah === s1 ? Math.max(1, a1) : 1;
    const to = surah === s2 ? Math.min(a2, table.length) : table.length;

    for (let aya = from; aya <= to; aya += 1) {
      const page = table[aya - 1];
      if (typeof page === 'number') out.push(page);
    }
  }

  return out;
}

/** أرقام الأجزاء التي غُطّيت صفحاتها كاملة دون استثناء */
function completedJuz(pages: ReadonlySet<number>): number[] {
  const done: number[] = [];

  JUZ_PAGES.forEach(([start, end], index) => {
    for (let page = start; page <= end; page += 1) {
      if (!pages.has(page)) return;
    }
    done.push(index + 1);
  });

  return done;
}

/* ===========================================================================
 *  استعلامات قاعدة البيانات
 * ======================================================================== */

const prisma = new PrismaClient();

async function fetchSessionDays(): Promise<Date[]> {
  const rows = await prisma.$queryRaw<SessionDayRow[]>`
    SELECT DISTINCT a.date AS session_date
    FROM attendance AS a
    WHERE EXTRACT(DOW FROM a.date)::int IN (6, 1, 3)
      AND a.date BETWEEN ${RANGE_FROM} AND ${RANGE_TO}
    ORDER BY session_date
  `;
  return rows.map((row) => row.session_date);
}

/** إحصاءات تشخيصية تُطبع عند التشغيل وتُدرج في ورقة الملخص */
async function fetchDiagnostics(): Promise<DiagnosticsRow> {
  const rows = await prisma.$queryRaw<DiagnosticsRow[]>`
    SELECT
      (SELECT COUNT(*) FROM attendance AS a
        WHERE a.date BETWEEN ${RANGE_FROM} AND ${RANGE_TO}
          AND EXTRACT(DOW FROM a.date)::int IN (6, 1, 3))::int      AS official_rows,
      (SELECT COUNT(*) FROM attendance AS a
        WHERE a.date BETWEEN ${RANGE_FROM} AND ${RANGE_TO}
          AND EXTRACT(DOW FROM a.date)::int NOT IN (6, 1, 3))::int  AS offday_rows,
      (SELECT COUNT(DISTINCT a.date) FROM attendance AS a
        WHERE a.date BETWEEN ${RANGE_FROM} AND ${RANGE_TO}
          AND EXTRACT(DOW FROM a.date)::int NOT IN (6, 1, 3))::int  AS offday_days,
      (SELECT COUNT(*) FROM points_log AS pl
        WHERE pl.description LIKE '%السبر بالأوقاف%')::int          AS awkaf_rows,
      (SELECT COUNT(*) FROM recitations)::int                       AS recitations_total,
      (SELECT COUNT(*) FROM recitations AS r
        WHERE r."startSurah" IS NULL OR r."startAya" IS NULL
           OR r."endSurah"   IS NULL OR r."endAya"   IS NULL)::int  AS recitations_without_pages
  `;
  return rows[0];
}

/** كل التسميعات المعتبَرة حفظاً، لاشتقاق الصفحات والأجزاء في TypeScript */
async function fetchRecitations(): Promise<RecitationRow[]> {
  return prisma.$queryRaw<RecitationRow[]>`
    SELECT
        r.student_id,
        r.surah_number,
        r."startSurah",
        r."startAya",
        r."endSurah",
        r."endAya",
        r.is_complete_sura
    FROM recitations AS r
    WHERE r.rating::text IN (${Prisma.join([...CONFIG.memorizedRatings])})
  `;
}

async function fetchReportRows(): Promise<ReportRow[]> {  return prisma.$queryRaw<ReportRow[]>`
    WITH session_days AS (
        SELECT DISTINCT a.date AS session_date
        FROM attendance AS a
        WHERE EXTRACT(DOW FROM a.date)::int IN (6, 1, 3)
          AND a.date BETWEEN ${RANGE_FROM} AND ${RANGE_TO}
    ),

    bounds AS (
        SELECT MAX(session_date) AS course_end FROM session_days
    ),

    student_start AS (
        SELECT
            s.id AS student_id,
            LEAST(
                s.created_at::date,
                COALESCE((
                    SELECT MIN(a.date)
                    FROM attendance AS a
                    WHERE a.student_id = s.id
                      AND EXTRACT(DOW FROM a.date)::int IN (6, 1, 3)
                      AND a.date BETWEEN ${RANGE_FROM} AND ${RANGE_TO}
                ), s.created_at::date)
            ) AS start_date
        FROM students AS s
        WHERE s.deleted_at IS NULL
    ),

    eligible AS (
        SELECT
            ss.student_id,
            (SELECT COUNT(*)::int FROM session_days AS d
              WHERE d.session_date >= ss.start_date) AS eligible_days
        FROM student_start AS ss
    ),

    attendance_agg AS (
        SELECT
            a.student_id,
            MAX(a.date)                                                  AS last_seen,
            COUNT(*) FILTER (WHERE a.status IN ('PRESENT', 'LATE'))::int AS attended_days,
            COUNT(*) FILTER (WHERE a.status = 'LATE')::int               AS late_days,
            COUNT(*) FILTER (WHERE a.status = 'ABSENT')::int             AS absent_days,
            COUNT(*)::int                                                AS recorded_days
        FROM attendance AS a
        INNER JOIN session_days AS d ON d.session_date = a.date
        GROUP BY a.student_id
    ),

    hadith_agg AS (
        SELECT hr.student_id, COUNT(*)::int AS hadith_count
        FROM hadith_recitations AS hr
        GROUP BY hr.student_id
    ),

    /* اللباس الأنيق: ضمن الفترة (سلوك متكرر) */
    neat_agg AS (
        SELECT pl.student_id, COUNT(*)::int AS neat_dress_count
        FROM points_log AS pl
        WHERE pl.description LIKE '%اللباس الأنيق%'
          AND pl.created_at::date BETWEEN ${RANGE_FROM} AND ${RANGE_TO}
        GROUP BY pl.student_id
    ),

    /* السبر بالأوقاف: تراكمي (حالة لا حدث)؛ يُؤخذ أعلى تقدير */
    awkaf_agg AS (
        SELECT
            pl.student_id,
            MAX(CASE
                WHEN pl.description LIKE '%ممتاز%'  THEN 3
                WHEN pl.description LIKE '%جيد جد%' THEN 2
                WHEN pl.description LIKE '%جيد%'    THEN 1
                ELSE 0
            END)::int AS awkaf_level
        FROM points_log AS pl
        WHERE pl.description LIKE '%السبر بالأوقاف%'
        GROUP BY pl.student_id
    ),

    /* النقاط: تراكمية. القيم مخزَّنة بإشارتها في points_log.amount،
       فالجمع المباشر صحيح ولا يُعاد اشتقاق الإشارة من نوع التصنيف */
    points_agg AS (
        SELECT
            pl.student_id,
            ROUND(SUM(pl.amount), 1)::float8 AS total_points
        FROM points_log AS pl
        GROUP BY pl.student_id
    ),

    report AS (
        SELECT
            s.id AS student_id,
            CASE s.grade
                WHEN 'الأول'  THEN  1  WHEN 'الثاني'  THEN  2
                WHEN 'الثالث' THEN  3  WHEN 'الرابع'  THEN  4
                WHEN 'الخامس' THEN  5  WHEN 'السادس'  THEN  6
                WHEN 'السابع' THEN  7  WHEN 'الثامن'  THEN  8
                WHEN 'التاسع' THEN  9  WHEN 'العاشر'  THEN 10
                WHEN 'الحادي عشر' THEN 11
                WHEN 'الثاني عشر' THEN 12
                ELSE 99
            END                                                          AS grade_order,
            s.full_name,
            s.father_name,
            s.school,
            s.grade,
            EXTRACT(YEAR FROM AGE(CURRENT_DATE, s.date_of_birth::date))::int AS age,
            i.full_name                                                  AS instructor_name,
            s.created_at::date                                           AS registered_on,

            CASE
                WHEN e.eligible_days < ${NEW_MAX}                THEN 'جديد'
                WHEN COALESCE(aa.recorded_days, 0) = 0           THEN 'بلا تسجيل'
                WHEN aa.last_seen < b.course_end - ${INACTIVE_AFTER} THEN 'منقطع'
                ELSE 'نشط'
            END                                                          AS status_label,

            aa.last_seen,
            e.eligible_days,
            COALESCE(aa.attended_days, 0)                                AS attended_days,
            COALESCE(aa.late_days, 0)                                    AS late_days,
            COALESCE(aa.absent_days, 0)                                  AS absent_days,
            e.eligible_days - COALESCE(aa.recorded_days, 0)              AS unrecorded_days,

            CASE
                WHEN e.eligible_days < ${NEW_MAX} THEN NULL
                ELSE ROUND(
                    COALESCE(aa.attended_days, 0)::numeric * 100
                    / NULLIF(e.eligible_days, 0)
                , 1)::float8
            END                                                          AS attendance_rate,

            /* تُحسب في TypeScript من ملف المصحف — انظر enrichWithMemorization */
            0::float8                                                    AS pages_memorized,
            0::int                                                       AS juz_count,
            NULL::text                                                   AS juz_list,
            COALESCE(ha.hadith_count, 0)                                 AS hadith_count,
            COALESCE(na.neat_dress_count, 0)                             AS neat_dress_count,
            COALESCE(aw.awkaf_level, 0)                                  AS awkaf_level,
            COALESCE(po.total_points, 0)                                 AS total_points

        FROM students AS s
        CROSS JOIN bounds          AS b
        INNER JOIN eligible        AS e  ON e.student_id  = s.id
        LEFT  JOIN instructors     AS i  ON i.id          = s.instructor_id
        LEFT  JOIN attendance_agg  AS aa ON aa.student_id = s.id
        LEFT  JOIN hadith_agg      AS ha ON ha.student_id = s.id
        LEFT  JOIN neat_agg        AS na ON na.student_id = s.id
        LEFT  JOIN awkaf_agg       AS aw ON aw.student_id = s.id
        LEFT  JOIN points_agg      AS po ON po.student_id = s.id
        WHERE s.deleted_at IS NULL
    )

    SELECT
        r.student_id,
        ROW_NUMBER() OVER (ORDER BY r.grade_order, r.full_name)::int AS seq,
        r.full_name, r.father_name, r.school, r.grade, r.age,
        r.instructor_name, r.registered_on, r.status_label, r.last_seen,
        r.eligible_days, r.attended_days, r.late_days, r.absent_days,
        r.unrecorded_days, r.attendance_rate,
        r.pages_memorized, r.juz_count, r.juz_list, r.hadith_count,
        r.neat_dress_count, r.awkaf_level, r.total_points
    FROM report AS r
    ORDER BY r.grade_order, r.full_name
  `;
}

/* ===========================================================================
 *  إثراء الصفوف بالحفظ المشتقّ من ملف المصحف
 * ======================================================================== */

interface EnrichStats {
  usable: number;
  unusable: number;
  studentsWithPages: number;
}

/**
 * يحسب لكل طالب: عدد الصفحات المغطاة فعلياً وأرقام الأجزاء المكتملة.
 *
 * لماذا هنا لا في SQL: حقلا startPage/endPage فارغان في كل السجلات،
 * والقيم اليدوية في pages_recited غير موثوقة (مثال: 6.25 صفحة لسورة
 * الشرح ذات الثماني آيات). الاشتقاق من السورة/الآية عبر ملف المصحف
 * يعطي نطاق الصفحات الحقيقي ولا يتأثر بأخطاء الإدخال.
 */
function enrichWithMemorization(
  rows: ReportRow[],
  recitations: RecitationRow[],
  meta: QuranMeta,
): EnrichStats {
  const pagesByStudent = new Map<string, Set<number>>();
  let usable = 0;
  let unusable = 0;

  for (const recitation of recitations) {
    const pages = pagesForRecitation(meta, recitation);

    if (pages.length === 0) {
      unusable += 1;
      continue;
    }
    usable += 1;

    let bucket = pagesByStudent.get(recitation.student_id);
    if (!bucket) {
      bucket = new Set<number>();
      pagesByStudent.set(recitation.student_id, bucket);
    }
    for (const page of pages) bucket.add(page);
  }

  for (const row of rows) {
    const pages = pagesByStudent.get(row.student_id) ?? new Set<number>();
    const juz = completedJuz(pages);

    row.pages_memorized = pages.size;
    row.juz_count = juz.length;
    row.juz_list = juz.length > 0 ? juz.join(',') : null;
  }

  return { usable, unusable, studentsWithPages: pagesByStudent.size };
}

/* ===========================================================================
 *  بناء ملف Excel
 * ======================================================================== */

type CellKind = 'text' | 'number' | 'date' | 'status' | 'juz' | 'awkaf';

interface ColumnSpec {
  key: keyof ReportRow;
  header: string;
  width: number;
  kind: CellKind;
  numFmt?: string;
  align?: 'right' | 'center';
  /** مجموعة الترويسة العلوية */
  group: 'basic' | 'attendance' | 'memorization' | 'conduct';
}

const COLUMNS: ColumnSpec[] = [
  { key: 'seq',              header: 'م',                width:  5, kind: 'number', group: 'basic' },
  { key: 'full_name',        header: 'اسم الطالب',       width: 24, kind: 'text', align: 'right', group: 'basic' },
  { key: 'father_name',      header: 'اسم الأب',         width: 13, kind: 'text', align: 'right', group: 'basic' },
  { key: 'school',           header: 'المدرسة',          width: 18, kind: 'text', align: 'right', group: 'basic' },
  { key: 'grade',            header: 'الصف',             width: 11, kind: 'text', group: 'basic' },
  { key: 'age',              header: 'العمر',            width:  7, kind: 'number', group: 'basic' },
  { key: 'instructor_name',  header: 'الأستاذ',          width: 20, kind: 'text', align: 'right', group: 'basic' },
  { key: 'registered_on',    header: 'تاريخ التسجيل',    width: 12, kind: 'date', group: 'basic' },

  { key: 'status_label',     header: 'الحالة',           width: 10, kind: 'status', group: 'attendance' },
  { key: 'last_seen',        header: 'آخر تسجيل',        width: 12, kind: 'date', group: 'attendance' },
  { key: 'eligible_days',    header: 'أيامه المؤهَّلة',   width: 11, kind: 'number', group: 'attendance' },
  { key: 'attended_days',    header: 'حضور',             width:  9, kind: 'number', group: 'attendance' },
  { key: 'late_days',        header: 'منها متأخر',       width: 10, kind: 'number', group: 'attendance' },
  { key: 'absent_days',      header: 'غياب',             width:  9, kind: 'number', group: 'attendance' },
  { key: 'unrecorded_days',  header: 'بدون تسجيل',       width: 11, kind: 'number', group: 'attendance' },
  { key: 'attendance_rate',  header: 'نسبة الحضور %',    width: 12, kind: 'number', numFmt: '0.0', group: 'attendance' },

  { key: 'pages_memorized',  header: 'الصفحات المحفوظة', width: 13, kind: 'number', group: 'memorization' },
  { key: 'juz_count',        header: 'أجزاء مكتملة',     width: 11, kind: 'number', group: 'memorization' },
  { key: 'juz_list',         header: 'أسماء الأجزاء',    width: 34, kind: 'juz', align: 'right', group: 'memorization' },
  { key: 'hadith_count',     header: 'أحاديث الأربعين',  width: 12, kind: 'number', group: 'memorization' },

  { key: 'neat_dress_count', header: 'اللباس الأنيق',    width: 11, kind: 'number', group: 'conduct' },
  { key: 'awkaf_level',      header: 'السبر بالأوقاف',   width: 15, kind: 'awkaf', group: 'conduct' },
  { key: 'total_points',     header: 'مجموع النقاط',     width: 12, kind: 'number', numFmt: '0.#', group: 'conduct' },
];

const GROUP_COLOR: Record<ColumnSpec['group'], string> = {
  basic: PALETTE.domeBlue,
  attendance: PALETTE.groupAttendance,
  memorization: PALETTE.groupMemorization,
  conduct: PALETTE.groupConduct,
};

const GROUP_LABEL: Record<ColumnSpec['group'], string> = {
  basic: 'بيانات الطالب',
  attendance: `الحضور (${CONFIG.dateFrom} ← ${CONFIG.dateTo})`,
  memorization: 'الحفظ (تراكمي)',
  conduct: 'السلوك والسبر والنقاط',
};

function applyBorders(row: ExcelJS.Row): void {
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = {
      top:    { style: 'thin', color: { argb: PALETTE.border } },
      left:   { style: 'thin', color: { argb: PALETTE.border } },
      bottom: { style: 'thin', color: { argb: PALETTE.border } },
      right:  { style: 'thin', color: { argb: PALETTE.border } },
    };
  });
}

function resolveRowFill(
  status: StudentStatus,
  rate: number | null,
  isOddRow: boolean,
): string | null {
  if (status === 'بلا تسجيل') return PALETTE.dangerFill;
  if (status === 'جديد') return PALETTE.neutralFill;
  if (status === 'منقطع') return PALETTE.mutedFill;
  if (rate !== null && rate < CONFIG.lowAttendanceThreshold) return PALETTE.dangerFill;
  if (rate !== null && rate < CONFIG.warningAttendanceThreshold) return PALETTE.warningFill;
  return isOddRow ? PALETTE.bandFill : null;
}

interface SheetOptions {
  /** اسم تبويب الورقة */
  name: string;
  /** العنوان الرئيسي داخل الورقة */
  title: string;
  /** سطر إضافي يوضّح شرط التصفية، إن وُجد */
  filterNote?: string;
  /** إعادة ترقيم العمود «م» تسلسلياً بدل استخدام الرقم الأصلي */
  renumber?: boolean;
}

function buildDetailSheet(
  workbook: ExcelJS.Workbook,
  rows: ReportRow[],
  sessionDays: Date[],
  opts: SheetOptions,
): void {
  const sheet = workbook.addWorksheet(opts.name, {
    views: [{ rightToLeft: true, state: 'frozen', xSplit: 2, ySplit: 5 }],
    pageSetup: {
      paperSize: PAPER_SIZE_A3, // 23 عموداً لا تُطبع مقروءة على A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      margins: { left: 0.3, right: 0.3, top: 0.5, bottom: 0.5, header: 0.3, footer: 0.3 },
    },
  });

  const lastCol = COLUMNS.length;

  // --- العنوان --------------------------------------------------------------
  sheet.mergeCells(1, 1, 1, lastCol);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = opts.title;
  titleCell.font = { name: CONFIG.fontName, size: 16, bold: true, color: { argb: PALETTE.domeBlue } };
  titleCell.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 28;

  // --- بيانات الفترة --------------------------------------------------------
  sheet.mergeCells(2, 1, 2, lastCol);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value =
    `أيام الدوام: السبت، الاثنين، الأربعاء   •   `
    + `الفترة: ${CONFIG.dateFrom} ← ${CONFIG.dateTo}   •   `
    + `أيام الدورة: ${sessionDays.length}   •   `
    + `عدد الطلاب: ${rows.length}   •   `
    + `الإصدار: ${formatDate(new Date())}`
    + (opts.filterNote ? `\n${opts.filterNote}` : '');
  subtitleCell.font = { name: CONFIG.fontName, size: 10, color: { argb: PALETTE.domeBlue } };
  subtitleCell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  sheet.getRow(2).height = opts.filterNote ? 34 : 20;

  // الصف 3 فاصل

  // --- ترويسة المجموعات (الصف 4) --------------------------------------------
  const groupRow = sheet.getRow(4);
  let cursor = 1;
  while (cursor <= lastCol) {
    const group = COLUMNS[cursor - 1].group;
    let end = cursor;
    while (end < lastCol && COLUMNS[end].group === group) end += 1;

    sheet.mergeCells(4, cursor, 4, end);
    const cell = sheet.getCell(4, cursor);
    cell.value = GROUP_LABEL[group];
    cell.font = { name: CONFIG.fontName, size: 11, bold: true, color: { argb: PALETTE.headerText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_COLOR[group] } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };

    cursor = end + 1;
  }
  groupRow.height = 22;
  applyBorders(groupRow);

  // --- رؤوس الأعمدة (الصف 5) ------------------------------------------------
  const headerRow = sheet.getRow(5);
  COLUMNS.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = col.header;
    cell.font = { name: CONFIG.fontName, size: 10, bold: true, color: { argb: PALETTE.headerText } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GROUP_COLOR[col.group] } };
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    sheet.getColumn(index + 1).width = col.width;
  });
  headerRow.height = 34;
  applyBorders(headerRow);

  // --- البيانات -------------------------------------------------------------
  rows.forEach((data, rowIndex) => {
    const excelRow = sheet.getRow(6 + rowIndex);
    const rate = data.attendance_rate === null ? null : toNum(data.attendance_rate);
    const status = data.status_label;

    COLUMNS.forEach((col, colIndex) => {
      const cell = excelRow.getCell(colIndex + 1);
      const raw = data[col.key];

      switch (col.kind) {
        case 'date':
          cell.value = formatDate(raw as Date | null);
          break;
        case 'number':
          cell.value = col.key === 'seq' && opts.renumber
            ? rowIndex + 1
            : raw === null || raw === undefined ? '—' : toNum(raw);
          break;
        case 'juz':
          cell.value = formatJuzList(raw as string | null);
          break;
        case 'awkaf':
          cell.value = AWKAF_LABEL[toNum(raw)] ?? 'لا';
          break;
        default:
          cell.value = raw === null || raw === undefined ? '—' : String(raw);
      }

      if (col.numFmt && typeof cell.value === 'number') cell.numFmt = col.numFmt;

      const emphasise = col.kind === 'status' || col.kind === 'awkaf';
      cell.font = {
        name: CONFIG.fontName,
        size: 10,
        bold: emphasise,
        color: col.kind === 'status'
          ? { argb: STATUS_COLOR[status] }
          : col.kind === 'awkaf' && toNum(data.awkaf_level) > 0
            ? { argb: PALETTE.islamicGreen }
            : undefined,
      };
      cell.alignment = {
        horizontal: col.align ?? 'center',
        vertical: 'middle',
        wrapText: col.kind === 'juz',
      };
    });

    const fillColor = resolveRowFill(status, rate, rowIndex % 2 === 1);
    if (fillColor) {
      excelRow.eachCell({ includeEmpty: true }, (cell) => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
      });
    }

    /* إبراز مَن أتمّ الأربعين النووية — يُطبَّق بعد تلوين الصف ليعلوه */
    if (toNum(data.hadith_count) >= CONFIG.hadithTotal) {
      const hadithIndex = COLUMNS.findIndex((c) => c.key === 'hadith_count');
      if (hadithIndex >= 0) {
        const cell = excelRow.getCell(hadithIndex + 1);
        cell.fill = {
          type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.completeFill },
        };
        cell.font = {
          name: CONFIG.fontName, size: 11, bold: true, color: { argb: PALETTE.completeText },
        };
      }
    }

    excelRow.height = 20;
    applyBorders(excelRow);
  });

  sheet.autoFilter = {
    from: { row: 5, column: 1 },
    to:   { row: 5 + rows.length, column: lastCol },
  };
  sheet.pageSetup.printTitlesRow = '4:5';
}

function buildSummarySheet(
  workbook: ExcelJS.Workbook,
  rows: ReportRow[],
  sessionDays: Date[],
  diag: DiagnosticsRow,
  filteredCount: number,
): void {
  const sheet = workbook.addWorksheet('ملخص ومفتاح', { views: [{ rightToLeft: true }] });
  sheet.getColumn(1).width = 38;
  sheet.getColumn(2).width = 46;

  const countByStatus = (status: StudentStatus): number =>
    rows.filter((r) => r.status_label === status).length;

  const averageOf = (subset: ReportRow[]): number => {
    const values = subset
      .map((r) => (r.attendance_rate === null ? null : toNum(r.attendance_rate)))
      .filter((v): v is number => v !== null);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
  };

  const activeRows = rows.filter((r) => r.status_label === 'نشط');
  const activeAndLapsed = rows.filter(
    (r) => r.status_label === 'نشط' || r.status_label === 'منقطع',
  );

  const totalPages = rows.reduce((sum, r) => sum + toNum(r.pages_memorized), 0);
  const totalJuz = rows.reduce((sum, r) => sum + toNum(r.juz_count), 0);
  const totalHadith = rows.reduce((sum, r) => sum + toNum(r.hadith_count), 0);
  const totalNeat = rows.reduce((sum, r) => sum + toNum(r.neat_dress_count), 0);
  const awkafPassed = rows.filter((r) => toNum(r.awkaf_level) > 0).length;

  const officialRows = toNum(diag.official_rows);
  const offdayRows = toNum(diag.offday_rows);
  const totalAttRows = officialRows + offdayRows;
  const offdayPct = totalAttRows > 0 ? (offdayRows * 100) / totalAttRows : 0;

  const entries: Array<[string, string | number]> = [
    ['الفترة المشمولة (الحضور)', `${CONFIG.dateFrom} ← ${CONFIG.dateTo}`],
    ['أيام الدوام الرسمية', 'السبت، الاثنين، الأربعاء'],
    ['عدد أيام الدورة', sessionDays.length],
    ['— — —', '— — —'],
    ['إجمالي عدد الطلاب', rows.length],
    ['نشط', countByStatus('نشط')],
    ['منقطع', countByStatus('منقطع')],
    ['جديد', countByStatus('جديد')],
    ['بلا تسجيل', countByStatus('بلا تسجيل')],
    ['— — —', '— — —'],
    ['متوسط الحضور — النشطون %', Number(averageOf(activeRows).toFixed(1))],
    ['متوسط الحضور — النشطون والمنقطعون %', Number(averageOf(activeAndLapsed).toFixed(1))],
    ['— — —', '— — —'],
    ['إجمالي الصفحات المحفوظة', Number(totalPages.toFixed(2))],
    ['إجمالي الأجزاء المكتملة', totalJuz],
    ['إجمالي أحاديث الأربعين', totalHadith],
    [`طلاب أتمّوا الأربعين النووية (${CONFIG.hadithTotal})`,
      rows.filter((r) => toNum(r.hadith_count) >= CONFIG.hadithTotal).length],
    ['مرات اللباس الأنيق (ضمن الفترة)', totalNeat],
    ['طلاب سبروا بالأوقاف', awkafPassed],
    ['إجمالي النقاط', Number(rows.reduce((s, r) => s + toNum(r.total_points), 0).toFixed(1))],
    ['— — —', '— — —'],
    ['عدد الطلاب في ورقة «المنتظمون»', filteredCount],
    [
      'شرط ورقة «المنتظمون»',
      `بلا منقطعين، و${CONFIG.filteredMinDays} `
        + `${CONFIG.filteredBasis === 'attended' ? 'أيام حضور فعلي' : 'أيام مؤهَّلة'} فأكثر`,
    ],
    ['— — —', '— — —'],
    ['صفوف الحضور المعتمدة', officialRows],
    ['صفوف مستبعدة (أيام غير رسمية)', `${offdayRows} (${offdayPct.toFixed(1)}%)`],
    ['تسميعات بلا صفحات مُحدَّدة', `${toNum(diag.recitations_without_pages)} من ${toNum(diag.recitations_total)}`],
    ['تاريخ إصدار التقرير', formatDate(new Date())],
  ];

  sheet.mergeCells(1, 1, 1, 2);
  const title = sheet.getCell(1, 1);
  title.value = 'ملخص التقرير ومفتاح القراءة';
  title.font = { name: CONFIG.fontName, size: 14, bold: true, color: { argb: PALETTE.domeBlue } };
  title.alignment = { horizontal: 'center', vertical: 'middle' };
  sheet.getRow(1).height = 26;

  entries.forEach(([label, value], index) => {
    const row = sheet.getRow(3 + index);
    const isDivider = label.startsWith('—');

    const labelCell = row.getCell(1);
    labelCell.value = isDivider ? '' : label;
    labelCell.font = { name: CONFIG.fontName, size: 11, bold: true, color: { argb: PALETTE.headerText } };
    if (!isDivider) {
      labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: PALETTE.domeBlue } };
    }
    labelCell.alignment = { horizontal: 'right', vertical: 'middle' };

    const valueCell = row.getCell(2);
    valueCell.value = isDivider ? '' : value;
    valueCell.font = { name: CONFIG.fontName, size: 11 };
    valueCell.alignment = { horizontal: 'right', vertical: 'middle' };

    row.height = isDivider ? 8 : 20;
    if (!isDivider) applyBorders(row);
  });

  let cursor = 3 + entries.length + 2;

  // --- مفتاح الألوان --------------------------------------------------------
  sheet.mergeCells(cursor, 1, cursor, 2);
  const legendTitle = sheet.getCell(cursor, 1);
  legendTitle.value = 'مفتاح ألوان الصفوف';
  legendTitle.font = { name: CONFIG.fontName, size: 12, bold: true, color: { argb: PALETTE.islamicGreen } };
  legendTitle.alignment = { horizontal: 'right', vertical: 'middle' };
  cursor += 1;

  const legend: Array<[string, string]> = [
    [PALETTE.dangerFill, `بلا تسجيل — أو نشط ونسبته أقل من ${CONFIG.lowAttendanceThreshold}%`],
    [PALETTE.warningFill, `نشط ونسبته بين ${CONFIG.lowAttendanceThreshold}% و ${CONFIG.warningAttendanceThreshold}%`],
    [PALETTE.neutralFill, `جديد — أقل من ${CONFIG.newStudentMaxDays} أيام دوام، والنسبة تُترك فارغة`],
    [PALETTE.mutedFill, `منقطع — لم يُسجَّل له شيء منذ أكثر من ${CONFIG.inactiveAfterDays} يوماً`],
    [PALETTE.bandFill, 'نشط وملتزم — التظليل للقراءة فقط، لا دلالة له'],
    [PALETTE.completeFill, `خانة ذهبية في عمود «أحاديث الأربعين» = أتمّ الأربعين النووية كاملة (${CONFIG.hadithTotal} حديثاً)`],
  ];

  legend.forEach(([color, text], index) => {
    const row = sheet.getRow(cursor + index);
    const swatch = row.getCell(1);
    swatch.value = '';
    swatch.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };

    const label = row.getCell(2);
    label.value = text;
    label.font = { name: CONFIG.fontName, size: 10 };
    label.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };

    row.height = 22;
    applyBorders(row);
  });
  cursor += legend.length + 2;

  // --- المنهجية -------------------------------------------------------------
  sheet.mergeCells(cursor, 1, cursor, 2);
  const methodTitle = sheet.getCell(cursor, 1);
  methodTitle.value = 'منهجية الاحتساب';
  methodTitle.font = { name: CONFIG.fontName, size: 12, bold: true, color: { argb: PALETTE.islamicGreen } };
  methodTitle.alignment = { horizontal: 'right', vertical: 'middle' };
  cursor += 1;

  const notes = [
    'أيام الحضور = الحضور + التأخير (المتأخر يُحتسب حاضراً).',
    'مقام النسبة = أيام الدوام الواقعة بعد تاريخ تسجيل الطالب، فلا يُحاسَب على أيام سبقت انضمامه.',
    'الحصص الإضافية في الأحد/الثلاثاء/الخميس مستبعدة بالكامل — حضوراً وغياباً معاً.',
    'الحضور واللباس الأنيق محسوبان ضمن الفترة المذكورة أعلاه.',
    'الصفحات والأجزاء والأحاديث والسبر بالأوقاف تراكمية من بداية سجل الطالب، لأن الحفظ رصيد لا نشاط دوري.',
    'الصفحات المحفوظة = عدد صفحات المصحف التي غطّاها تسميع الطالب فعلياً، مشتقّة من السورة والآية عبر بيانات المصحف المدني (حفص) لا من الإدخال اليدوي.',
    'الجزء يُعدّ محفوظاً فقط إذا غُطّيت كل صفحاته دون استثناء.',
    'تُحتسب حفظاً التسميعات ذات تقدير «جيد» أو «جيد جداً» فقط؛ وتُستبعد «إعادة» و«مقرأة جماعية» و«لم يحفظ».',
    'عمود «بدون تسجيل» = أيام دوام لم يُفتح فيها سجل الطالب، وهي ليست غياباً بل فجوة في التسجيل.',
    'مجموع النقاط تراكمي من كل مصادر النقاط (حضور، تسميع، أحاديث، سلوك، سبر)، والخصومات محسوبة ضمنه.',
    `ورقة «المنتظمون» تستبعد الطلاب المنقطعين وتشترط ${CONFIG.filteredMinDays} `
      + `${CONFIG.filteredBasis === 'attended' ? 'أيام حضور فعلي' : 'أيام مؤهَّلة'} فأكثر، `
      + 'وهي مرتّبة تنازلياً حسب مجموع النقاط.',
  ];

  notes.forEach((note, index) => {
    const row = sheet.getRow(cursor + index);
    sheet.mergeCells(cursor + index, 1, cursor + index, 2);
    const cell = row.getCell(1);
    cell.value = `${index + 1}. ${note}`;
    cell.font = { name: CONFIG.fontName, size: 10 };
    cell.alignment = { horizontal: 'right', vertical: 'middle', wrapText: true };
    row.height = 34;
  });
  cursor += notes.length + 2;

  // --- أيام الدوام ----------------------------------------------------------
  sheet.mergeCells(cursor, 1, cursor, 2);
  const daysTitle = sheet.getCell(cursor, 1);
  daysTitle.value = `أيام الدوام المسجّلة (${sessionDays.length} يوم)`;
  daysTitle.font = { name: CONFIG.fontName, size: 12, bold: true, color: { argb: PALETTE.islamicGreen } };
  daysTitle.alignment = { horizontal: 'right', vertical: 'middle' };

  sessionDays.forEach((day, index) => {
    const row = sheet.getRow(cursor + 1 + index);
    const date = new Date(day);
    row.getCell(1).value = formatDate(date);
    row.getCell(2).value = ARABIC_WEEKDAYS[date.getUTCDay()];
    row.eachCell({ includeEmpty: false }, (cell) => {
      cell.font = { name: CONFIG.fontName, size: 10 };
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
    });
    applyBorders(row);
  });
}

/* ===========================================================================
 *  نقطة الدخول
 * ======================================================================== */

async function main(): Promise<void> {
  console.log(`▶ الفترة المشمولة: ${CONFIG.dateFrom} ← ${CONFIG.dateTo}`);

  console.log('▶ جارٍ حساب أيام الدوام الرسمية…');
  const sessionDays = await fetchSessionDays();
  console.log(`  عدد أيام الدوام: ${sessionDays.length}`);

  if (sessionDays.length === 0) {
    throw new Error(
      `لم يُعثر على أي يوم دوام رسمي بين ${CONFIG.dateFrom} و ${CONFIG.dateTo}. `
        + 'تحقّق من المجال الزمني في CONFIG.',
    );
  }

  console.log('▶ جارٍ جمع الإحصاءات التشخيصية…');
  const diag = await fetchDiagnostics();
  console.log(`  حضور معتمد: ${toNum(diag.official_rows)}  |  مستبعد: ${toNum(diag.offday_rows)}`);
  console.log(`  سجلات السبر بالأوقاف: ${toNum(diag.awkaf_rows)}`);
  console.log(
    `  تسميعات بلا نطاق آيات (لا تدخل حساب الأجزاء): ${toNum(diag.recitations_without_pages)}`
      + ` من ${toNum(diag.recitations_total)}`,
  );

  if (toNum(diag.awkaf_rows) === 0) {
    console.warn('  ⚠ لا توجد أي سجلات للسبر بالأوقاف — سيظهر العمود «لا» للجميع.');
  }

  console.log('▶ جارٍ تجميع بيانات الطلاب…');
  const rows = await fetchReportRows();
  console.log(`  عدد الطلاب: ${rows.length}`);

  if (rows.length === 0) {
    throw new Error('لم يُعثر على أي طالب غير محذوف في جدول students.');
  }

  console.log('▶ جارٍ اشتقاق الصفحات والأجزاء من ملف المصحف…');
  const quranMeta = loadQuranMeta();
  const recitations = await fetchRecitations();
  const enrich = enrichWithMemorization(rows, recitations, quranMeta);
  console.log(
    `  تسميعات قابلة للاشتقاق: ${enrich.usable} من ${recitations.length}`
      + `  |  غير قابلة: ${enrich.unusable}`,
  );
  console.log(`  طلاب لهم صفحات مشتقّة: ${enrich.studentsWithPages}`);

  const knownGrades = new Set([
    'الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس',
    'السابع', 'الثامن', 'التاسع', 'العاشر', 'الحادي عشر', 'الثاني عشر',
  ]);
  const unknown = [
    ...new Set(rows.map((r) => r.grade).filter((g): g is string => !!g && !knownGrades.has(g))),
  ];
  if (unknown.length > 0) {
    console.warn(`  ⚠ صفوف غير معرّفة في ترتيب CASE: ${unknown.join('، ')}`);
  }

  const missingInstructor = rows.filter((r) => !r.instructor_name).length;
  if (missingInstructor > 0) {
    console.warn(`  ⚠ طلاب بلا أستاذ مرتبط: ${missingInstructor}`);
  }

  const statusCounts = rows.reduce<Record<string, number>>((acc, r) => {
    acc[r.status_label] = (acc[r.status_label] ?? 0) + 1;
    return acc;
  }, {});
  console.log(
    `  التصنيف — ${Object.entries(statusCounts).map(([k, v]) => `${k}: ${v}`).join('  |  ')}`,
  );
  console.log(
    `  الحفظ — أجزاء مكتملة: ${rows.reduce((s, r) => s + toNum(r.juz_count), 0)}`
      + `  |  أحاديث: ${rows.reduce((s, r) => s + toNum(r.hadith_count), 0)}`
      + `  |  أتمّوا الأربعين: ${rows.filter((r) => toNum(r.hadith_count) >= CONFIG.hadithTotal).length}`
      + `  |  لباس أنيق: ${rows.reduce((s, r) => s + toNum(r.neat_dress_count), 0)}`,
  );

  console.log('▶ جارٍ بناء ملف Excel…');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Taqwa — نظام إدارة تحفيظ القرآن';
  workbook.created = new Date();

  // الورقة الأولى: كل الطلاب
  buildDetailSheet(workbook, rows, sessionDays, {
    name: 'التقرير الشامل',
    title: 'التقرير الشامل للطلاب — دورة تحفيظ القرآن الكريم',
  });

  // الورقة الثانية: المنتظمون — بلا منقطعين، وبحدّ أدنى من أيام الدوام
  const basisLabel = CONFIG.filteredBasis === 'attended' ? 'أيام حضور فعلي' : 'أيام مؤهَّلة';
  const filtered = rows
    .filter((r) => r.status_label !== 'منقطع')
    .filter((r) => {
      const basis = CONFIG.filteredBasis === 'attended'
        ? toNum(r.attended_days)
        : toNum(r.eligible_days);
      return basis >= CONFIG.filteredMinDays;
    })
    .sort((a, b) => toNum(b.total_points) - toNum(a.total_points));

  console.log(`  الورقة المصفّاة: ${filtered.length} طالب من ${rows.length}`);

  buildDetailSheet(workbook, filtered, sessionDays, {
    name: 'المنتظمون',
    title: 'كشف الطلاب المنتظمين — مرتّب حسب مجموع النقاط',
    filterNote:
      `شرط الإدراج: استُبعد الطلاب المنقطعون، ويشترط ${CONFIG.filteredMinDays} `
      + `${basisLabel} فأكثر  •  الترتيب تنازلي حسب مجموع النقاط`,
    renumber: true,
  });

  buildSummarySheet(workbook, rows, sessionDays, diag, filtered.length);

  fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  const outputPath = path.join(CONFIG.outputDir, `student-full-report-${fileTimestamp()}.xlsx`);
  await workbook.xlsx.writeFile(outputPath);

  console.log(`✔ تم إنشاء الملف بنجاح:\n  ${outputPath}`);
}

main()
  .catch((error: unknown) => {
    console.error('✖ فشل إنشاء التقرير:');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });