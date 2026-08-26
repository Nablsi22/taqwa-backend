import { PrismaClient, Prisma } from '@prisma/client';
import * as fs from 'fs';
import { calculatePages, getSurahMeta } from '../src/quran-metadata/quran-ayat-pages.util';

const url = process.env.AUDIT_DATABASE_URL;
if (!url || !/^postgres/.test(url)) throw new Error('ABORT: bad AUDIT_DATABASE_URL');
const prisma = new PrismaClient({ datasources: { db: { url } } });
const n = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));
const r2 = (x: number) => Math.round(x * 100) / 100;

const PTS: Record<string, number> = { GOOD: 1, VERY_GOOD: 2, MAQRAA: 0 };
function pts(rating: string, pages: number): number {
  if (pages <= 0) return 0;
  if (rating === 'MAQRAA') return 0;
  if (!(rating in PTS)) return 0;
  if (pages >= 5) return 3 * pages;
  return PTS[rating] * pages;
}
function precise(s: number): number {
  const m = getSurahMeta(s);
  return m ? calculatePages(s, 1, s, m.numAyas) : 0;
}

async function main() {
  const recs = await prisma.recitation.findMany({
    where: { isCompleteSura: true },
    include: { student: { select: { fullName: true, fatherName: true } } },
  });

  const by = new Map<string, { name: string; oldP: number; newP: number; k: number }>();
  for (const r of recs) {
    const list = r.surahNumbers?.length ? r.surahNumbers : [r.surahNumber];
    const oldPages = n(r.pagesRecited);
    const newPages = Math.round(list.reduce((s, x) => s + precise(x), 0) * 1000) / 1000;
    const name = (r.student.fullName + ' ' + (r.student.fatherName ?? '')).trim();
    const e = by.get(r.studentId) ?? { name, oldP: 0, newP: 0, k: 0 };
    e.oldP += pts(r.rating, oldPages);
    e.newP += pts(r.rating, newPages);
    e.k++;
    by.set(r.studentId, e);
  }

  const rows = Array.from(by.values())
    .map((e) => ({ ...e, d: r2(e.newP - e.oldP),
      pct: e.oldP ? Math.round(((e.newP - e.oldP) / e.oldP) * 1000) / 10 : 0 }))
    .sort((a, b) => a.d - b.d);

  fs.writeFileSync('fullsura-impact.csv', '\uFEFF' +
    'student,pts_old,pts_new,delta,pct,recitations\n' +
    rows.map((r) => ['"'+r.name+'"', r2(r.oldP), r2(r.newP), r.d, r.pct+'%', r.k].join(',')).join('\n'), 'utf8');

  const dn = rows.filter((r) => r.d < -0.01).map((r) => Math.abs(r.pct)).sort((a,b)=>a-b);
  console.log('\n==== FULL-SURA ROWS ONLY (the real bug) ====');
  console.log('rows            : ' + recs.length);
  console.log('students touched: ' + rows.length);
  console.log('  decreased     : ' + dn.length);
  console.log('  unchanged/up  : ' + (rows.length - dn.length));
  if (dn.length) {
    console.log('drop %  median  : ' + dn[Math.floor(dn.length/2)] + '%');
    console.log('        worst   : ' + dn[dn.length-1] + '%');
    console.log('        over 10%: ' + dn.filter(p=>p>10).length + ' students');
  }
  console.log('\nCSV: fullsura-impact.csv');
}
main().catch((e)=>{console.error(e);process.exitCode=1;}).finally(()=>prisma.$disconnect());