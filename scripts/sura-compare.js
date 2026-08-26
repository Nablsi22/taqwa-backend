"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const quran_ayat_pages_util_1 = require("../src/quran-metadata/quran-ayat-pages.util");
const quran_metadata_1 = require("../src/quran-metadata/quran-metadata");
const TOP = [1, 109, 99, 78, 103, 106, 82, 97, 112, 101, 95, 100, 93, 86, 91, 94, 108, 80, 105, 85];
const COUNT = {
    1: 42, 109: 25, 99: 21, 78: 21, 103: 21, 106: 21, 82: 21, 97: 20, 112: 19, 101: 18,
    95: 16, 100: 15, 93: 15, 86: 14, 91: 14, 94: 13, 108: 13, 80: 12, 105: 12, 85: 12,
};
console.log('\nسورة              | مُعدّ | دقيق  | فرق    | تسجيلات');
console.log('------------------|------|-------|--------|--------');
let wOld = 0, wNew = 0, wN = 0;
for (const s of TOP) {
    const meta = (0, quran_ayat_pages_util_1.getSurahMeta)(s);
    const cur = (0, quran_metadata_1.getSuraByNumber)(s);
    if (!meta || !cur)
        continue;
    const precise = (0, quran_ayat_pages_util_1.calculatePages)(s, 1, s, meta.numAyas);
    const old = cur.totalPages;
    const pct = ((precise - old) / old) * 100;
    const k = COUNT[s] ?? 0;
    wOld += old * k;
    wNew += precise * k;
    wN += k;
    console.log((String(s) + ' ' + meta.nameAr).padEnd(18) + '| ' +
        old.toFixed(2).padStart(4) + ' | ' +
        precise.toFixed(3).padStart(5) + ' | ' +
        (pct >= 0 ? '+' : '') + pct.toFixed(1).padStart(5) + '% | ' +
        String(k).padStart(3));
}
console.log('\nمرجّح بعدد التسجيلات (n=' + wN + '):');
console.log('  مجموع مُعدّ : ' + wOld.toFixed(2));
console.log('  مجموع دقيق : ' + wNew.toFixed(2));
console.log('  الفرق      : ' + (((wNew - wOld) / wOld) * 100).toFixed(1) + '%');
//# sourceMappingURL=sura-compare.js.map