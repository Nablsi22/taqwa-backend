import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const hash = await bcrypt.hash('Taqwa@2026', 12);
  const user = await prisma.user.create({
    data: { username: 'instructor1', passwordHash: hash, role: 'INSTRUCTOR', isActive: true },
  });
  const instructor = await prisma.instructor.create({
    data: { userId: user.id, fullName: 'أحمد المعلم' },
  });
  console.log('Instructor ID:', instructor.id);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());