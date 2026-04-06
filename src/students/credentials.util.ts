import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Character set for auto-generated passwords.
 * Excludes confusing characters: 0/O/o, 1/l/I.
 * Letters: a-z minus o, l, i
 * Digits:  2-9
 */
const PASSWORD_CHARSET = 'abcdefghjkmnpqrstuvwxyz23456789';

/**
 * Generate a cryptographically random 8-character password.
 * Uses crypto.randomInt (CSPRNG), NOT Math.random.
 */
export function generatePassword(length = 8): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += PASSWORD_CHARSET[randomInt(0, PASSWORD_CHARSET.length)];
  }
  return result;
}

/**
 * Hash a plain password using bcrypt with the same cost factor used
 * elsewhere in the codebase (12 rounds).
 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 12);
}

/**
 * Generate a unique username in the format YYYYNNNN where:
 *  - YYYY = student's birth year
 *  - NNNN = sequential 4-digit number within that year (0001, 0002, ...)
 *
 * Guarantees uniqueness by querying the highest existing username
 * for the year and incrementing it. The unique constraint on
 * users.username acts as a final safety net.
 */
export async function generateUniqueUsername(
  prisma: PrismaService,
  dateOfBirth: Date,
): Promise<string> {
  const year = dateOfBirth.getFullYear();
  const prefix = year.toString();

  // Find the highest existing username for this year
  const last = await prisma.user.findFirst({
    where: {
      username: {
        startsWith: prefix,
      },
      role: 'STUDENT',
    },
    orderBy: { username: 'desc' },
    select: { username: true },
  });

  let nextNumber = 1;
  if (last?.username && last.username.length === 8) {
    const tail = parseInt(last.username.slice(4), 10);
    if (!isNaN(tail)) nextNumber = tail + 1;
  }

  // Pad to 4 digits
  const padded = nextNumber.toString().padStart(4, '0');
  return `${prefix}${padded}`;
}

/**
 * Generate a fresh credential pair (username + plain password + hash)
 * for a new student. Username depends on birth year for uniqueness.
 */
export async function generateCredentials(
  prisma: PrismaService,
  dateOfBirth: Date,
): Promise<{ username: string; plainPassword: string; passwordHash: string }> {
  const username = await generateUniqueUsername(prisma, dateOfBirth);
  const plainPassword = generatePassword();
  const passwordHash = await hashPassword(plainPassword);
  return { username, plainPassword, passwordHash };
}

/**
 * Generate a fresh password only (used when resetting an existing
 * student's password — username stays the same).
 */
export async function generateNewPassword(): Promise<{
  plainPassword: string;
  passwordHash: string;
}> {
  const plainPassword = generatePassword();
  const passwordHash = await hashPassword(plainPassword);
  return { plainPassword, passwordHash };
}