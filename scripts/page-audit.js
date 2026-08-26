"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const client_1 = require("@prisma/client");
const fs = __importStar(require("fs"));
const quran_ayat_pages_util_1 = require("../src/quran-metadata/quran-ayat-pages.util");
const url = process.env.AUDIT_DATABASE_URL;
if (!url)
    throw new Error('ABORT: AUDIT_DATABASE_URL is not set.');
if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new Error('ABORT: AUDIT_DATABASE_URL is not a connection string.');
}
if (/railway\.internal/.test(url)) {
    throw new Error('ABORT: internal host — use DATABASE_PUBLIC_URL.');
}
const prisma = new client_1.PrismaClient({ datasources: { db: { url } } });
const num = (v) => v == null ? 0 : Number(v);
const r3 = (n) => Math.round(n * 1000) / 1000;
const r2 = (n) => Math.round(n * 100) / 100;
function computePoints(rating, pages, rules) {
    if (!rating || rating === 'REPEAT' || rating === 'DID_NOT_MEMORIZE')
        return 0;
    if (pages <= 0)
        return 0;
    if (rating === 'MAQRAA') {
        const r = rules['RECITE_MAQRAA'];
        if (!r || !r.isActive)
            return 0;
        return r.isPerPage ? r.points * pages : r.points;
    }
    if (pages >= 5) {
        const b = rules['RECITE_5PLUS_PAGES'];
        if (b && b.isActive && b.minPages && pages >= b.minPages) {
            return b.points * pages;
        }
    }
    const map = {
        GOOD: 'RECITE_GOOD',
        VERY_GOOD: 'RECITE_VERY_GOOD',
    };
    const code = map[rating];
    if (!code)
        return 0;
    const r = rules[code];
    return r && r.isActive ? r.points * pages : 0;
}
function precisePagesForFullSura(n) {
    const meta = (0, quran_ayat_pages_util_1.getSurahMeta)(n);
    if (!meta)
        return 0;
    return (0, quran_ayat_pages_util_1.calculatePages)(n, 1, n, meta.numAyas);
}
async function main() {
    const ruleRows = await prisma.pointRule.findMany({ orderBy: { code: 'asc' } });
    const rules = {};
    for (const r of ruleRows) {
        rules[r.code] = {
            points: num(r.points),
            isActive: r.isActive,
            isPerPage: r.isPerPage,
            minPages: r.minPages,
        };
    }
    console.log('\n=== POINT RULES (recitation-related) ===');
    for (const r of ruleRows) {
        if (!r.code.startsWith('RECITE'))
            continue;
        console.log('  ' + r.code.padEnd(22) +
            ' points=' + String(r.points).padStart(3) +
            '  perPage=' + String(r.isPerPage).padEnd(5) +
            '  minPages=' + String(r.minPages ?? '-').padStart(2) +
            '  active=' + r.isActive);
    }
    const recitations = await prisma.recitation.findMany({
        include: { student: { select: { fullName: true, fatherName: true } } },
    });
    const logs = await prisma.pointsLog.findMany({
        where: { sourceId: { in: recitations.map((x) => x.id) } },
        select: { sourceId: true, amount: true },
    });
    const logged = new Map();
    for (const l of logs) {
        if (!l.sourceId)
            continue;
        logged.set(l.sourceId, (logged.get(l.sourceId) ?? 0) + num(l.amount));
    }
    const byStudent = new Map();
    const details = [
        'recitation_id,student,term,mode,rating,pages_old,pages_new,pts_logged,pts_old_calc,pts_new_calc,delta_pages,delta_drift,crossed5',
    ];
    let skippedNoData = 0;
    let crossedThreshold = 0;
    let driftTotal = 0;
    let noLogRow = 0;
    for (const rec of recitations) {
        const oldPages = num(rec.pagesRecited);
        let newPages;
        let mode;
        if (rec.isCompleteSura) {
            const list = rec.surahNumbers && rec.surahNumbers.length
                ? rec.surahNumbers
                : [rec.surahNumber];
            newPages = list.reduce((s, n) => s + precisePagesForFullSura(n), 0);
            mode = 'full_sura';
        }
        else if (rec.startSurah && rec.startAya && rec.endSurah && rec.endAya) {
            newPages = (0, quran_ayat_pages_util_1.calculatePages)(rec.startSurah, rec.startAya, rec.endSurah, rec.endAya);
            mode = 'aya_range';
        }
        else {
            newPages = oldPages;
            mode = 'legacy_nodata';
            skippedNoData++;
        }
        newPages = r3(newPages);
        const hasLog = logged.has(rec.id);
        if (!hasLog)
            noLogRow++;
        const ptsLogged = hasLog ? logged.get(rec.id) : 0;
        const ptsOldCalc = r3(computePoints(rec.rating, oldPages, rules));
        const ptsNewCalc = r3(computePoints(rec.rating, newPages, rules));
        const deltaPages = r3(ptsNewCalc - ptsOldCalc);
        const deltaDrift = hasLog ? r3(ptsLogged - ptsOldCalc) : 0;
        driftTotal += deltaDrift;
        const crossed = oldPages >= 5 !== newPages >= 5;
        if (crossed)
            crossedThreshold++;
        const name = (rec.student.fullName + ' ' + (rec.student.fatherName ?? '')).trim();
        const row = byStudent.get(rec.studentId) ?? {
            student: name,
            logged: 0,
            oldCalc: 0,
            newCalc: 0,
            affected: 0,
        };
        row.logged += ptsLogged;
        row.oldCalc += ptsOldCalc;
        row.newCalc += ptsNewCalc;
        if (Math.abs(deltaPages) > 0.001)
            row.affected++;
        byStudent.set(rec.studentId, row);
        if (Math.abs(deltaPages) > 0.001 || Math.abs(deltaDrift) > 0.001) {
            details.push([
                rec.id, '"' + name + '"', rec.termId ?? '', mode, rec.rating,
                oldPages, newPages, ptsLogged, ptsOldCalc, ptsNewCalc,
                deltaPages, deltaDrift, crossed ? 'YES' : '',
            ].join(','));
        }
    }
    const summary = Array.from(byStudent.values())
        .map((r) => ({
        student: r.student,
        affected: r.affected,
        logged: r2(r.logged),
        oldCalc: r2(r.oldCalc),
        newCalc: r2(r.newCalc),
        delta: r2(r.newCalc - r.oldCalc),
        pct: r.oldCalc !== 0 ? Math.round(((r.newCalc - r.oldCalc) / Math.abs(r.oldCalc)) * 1000) / 10 : 0,
    }))
        .sort((a, b) => a.delta - b.delta);
    const bom = '\uFEFF';
    fs.writeFileSync('page-audit-summary.csv', bom + 'student,pts_logged,pts_old_calc,pts_new_calc,delta_pages,pct,affected\n' +
        summary.map((r) => ['"' + r.student + '"', r.logged, r.oldCalc, r.newCalc, r.delta, r.pct + '%', r.affected].join(',')).join('\n'), 'utf8');
    fs.writeFileSync('page-audit-details.csv', bom + details.join('\n'), 'utf8');
    const down = summary.filter((r) => r.delta < -0.01);
    const pcts = down.map((r) => Math.abs(r.pct)).sort((a, b) => a - b);
    const median = pcts.length ? pcts[Math.floor(pcts.length / 2)] : 0;
    console.log('\n======== IMPACT (pages effect only) ========');
    console.log('recitations total     : ' + recitations.length);
    console.log('  legacy w/o range    : ' + skippedNoData);
    console.log('  without points_log  : ' + noLogRow);
    console.log('  crossed 5-page line : ' + crossedThreshold);
    console.log('rules-drift total     : ' + r2(driftTotal) + '  (should be ~0 if rules unchanged)');
    console.log('');
    console.log('students total        : ' + summary.length);
    console.log('  DECREASED           : ' + down.length);
    console.log('  INCREASED           : ' + summary.filter((r) => r.delta > 0.01).length);
    console.log('  unchanged           : ' + summary.filter((r) => Math.abs(r.delta) <= 0.01).length);
    console.log('');
    console.log('among decreased — drop %:');
    console.log('  median              : ' + median + '%');
    console.log('  worst               : ' + (pcts.length ? pcts[pcts.length - 1] : 0) + '%');
    console.log('  over 20%            : ' + pcts.filter((p) => p > 20).length + ' students');
    console.log('  over 10%            : ' + pcts.filter((p) => p > 10).length + ' students');
    console.log('  5% or less          : ' + pcts.filter((p) => p <= 5).length + ' students');
    console.log('\nCSV written: page-audit-summary.csv , page-audit-details.csv');
}
main()
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
//# sourceMappingURL=page-audit.js.map