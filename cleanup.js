const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function run() {
  const cats = await p.pointCategory.findMany({ orderBy: [{ name: 'asc' }, { createdAt: 'asc' }] });
  const seen = new Map();
  const dupes = [];
  for (const c of cats) {
    if (seen.has(c.name)) {
      dupes.push(c.id);
    } else {
      seen.set(c.name, c.id);
    }
  }
  if (dupes.length > 0) {
    // Move any points_log from duplicate to original
    for (const dupeId of dupes) {
      const dupe = cats.find(c => c.id === dupeId);
      const originalId = seen.get(dupe.name);
      await p.pointsLog.updateMany({
        where: { categoryId: dupeId },
        data: { categoryId: originalId }
      });
    }
    // Now safe to delete
    const del = await p.pointCategory.deleteMany({ where: { id: { in: dupes } } });
    console.log('Deleted ' + del.count + ' duplicates');
  } else {
    console.log('No duplicates');
  }
  await p['$disconnect']();
}
run();