import { PrismaClient, Prisma } from '@prisma/client';
import { calculatePages } from '../src/quran-metadata/quran-ayat-pages.util';

const url = process.env.AUDIT_DATABASE_URL;
if (!url || !/^postgres/.test(url)) throw new Error('ABORT: bad AUDIT_DATABASE_URL');
const prisma = new PrismaClient({ datasources: { db: { url } } });
const n = (v: Prisma.Decimal | number | null | undefined) => (v == null ? 0 : Number(v));

async function main() {
  const recs = await prisma.recitation.findMany();

  let fullSura = 0, ayaSame = 0, ayaCross = 0, noData = 0;
  let crossPagesLost = 0, zeroNew = 0;
  const suspicious: string[] = [];

  for (const r of recs) {
    const old = n(r.pagesRecited);
    if (r.isCompleteSura) { fullSura++; continue; }
    if (!(r.startSurah && r.startAya && r.endSurah && r.endAya)) { noData++; continue; }

    if (r.startSurah !== r.endSurah) {
      ayaCross++;
      crossPagesLost += old;
      continue;
    }
    ayaSame++;
    const fresh = calculatePages(r.startSurah, r.startAya, r.endSurah, r.endAya);
    if (fresh === 0 && old > 0) zeroNew++;
    // فجوة كبيرة = دليل على تسميعة متعددة المقاطع
    if (old > 0 && Math.abs(fresh - old) / old > 0.15) {
      suspicious.push(
        `${r.startSurah}:${r.startAya}-${r.endAya}  stored=${old}  recomputed=${fresh.toFixed(3)}`,
      );
    }
  }

  console.log('\n=== RECITATION ANATOMY (n=' + recs.length + ') ===');
  console.log('  full_sura mode      : ' + fullSura);
  console.log('  aya_range same-sura : ' + ayaSame);
  console.log('  aya_range CROSS-sura: ' + ayaCross + '   <-- calculatePages returns 0 for these');
  console.log('     pages they hold  : ' + Math.round(crossPagesLost * 100) / 100);
  console.log('  no range data       : ' + noData);
  console.log('  same-sura -> 0 pages: ' + zeroNew);
  console.log('\n=== same-sura rows where recompute differs >15% (first 25) ===');
  console.log('  count: ' + suspicious.length);
  suspicious.slice(0, 25).forEach((s) => console.log('  ' + s));
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => prisma.$disconnect());