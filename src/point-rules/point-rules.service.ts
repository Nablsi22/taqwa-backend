import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PointRulesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get all rules (for admin screen)
   */
  async findAll() {
    const rules = await this.prisma.pointRule.findMany({
      where: { isActive: true },
      orderBy: [{ isAutomatic: 'desc' }, { points: 'desc' }],
    });
    return { data: rules };
  }

  /**
   * Get a single rule by code (used internally by other services)
   */
  async findByCode(code: string) {
    return this.prisma.pointRule.findUnique({ where: { code } });
  }

  /**
   * Update ONLY the point value of a rule (admin action)
   */
  async updatePoints(id: string, points: number) {
    const rule = await this.prisma.pointRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('القاعدة غير موجودة');

    // Preserve sign: earn rules must be positive, deduct must be negative
    const isDeduct = rule.points < 0;
    const absPoints = Math.abs(points);
    const finalPoints = isDeduct ? -absPoints : absPoints;

    const updated = await this.prisma.pointRule.update({
      where: { id },
      data: { points: finalPoints },
    });

    return { message: 'تم تحديث النقاط بنجاح', data: updated };
  }

  /**
   * Admin adds a new manual rule
   */
  async createManualRule(dto: { nameAr: string; points: number; description?: string }) {
    const code = 'CUSTOM_' + Date.now();

    const rule = await this.prisma.pointRule.create({
      data: {
        code,
        nameAr: dto.nameAr,
        description: dto.description || null,
        points: dto.points,
        isPerPage: false,
        isAutomatic: false,
        isDeletable: true,
      },
    });

    return { message: 'تم إضافة القاعدة بنجاح', data: rule };
  }

  /**
   * Delete a rule (only if isDeletable = true)
   */
  async remove(id: string) {
    const rule = await this.prisma.pointRule.findUnique({ where: { id } });
    if (!rule) throw new NotFoundException('القاعدة غير موجودة');
    if (!rule.isDeletable) {
      throw new BadRequestException('لا يمكن حذف هذه القاعدة لأنها أساسية');
    }
    await this.prisma.pointRule.delete({ where: { id } });
    return { message: 'تم حذف القاعدة بنجاح' };
  }

  // ═══════════════════════════════════════════════════════════
  // AUTO-POINTS CALCULATION (called by other services)
  // ═══════════════════════════════════════════════════════════

  /**
   * Calculate points for attendance status
   */
  async getAttendancePoints(status: 'PRESENT' | 'LATE' | 'ABSENT'): Promise<{ points: number; ruleNameAr: string } | null> {
    const codeMap: Record<string, string> = {
      PRESENT: 'ATTEND_ON_TIME',
      LATE: 'LATE',
      ABSENT: 'ABSENT',
    };

    const rule = await this.findByCode(codeMap[status]);
    if (!rule || !rule.isActive) return null;

    return { points: rule.points, ruleNameAr: rule.nameAr };
  }

  /**
   * Calculate points for recitation (FIXED)
   *
   * FIX 1: Corrected DID_NOT_MEMORIZE check (was NO_MEMORIZATION)
   * FIX 2: Added MAQRAA handling via RECITE_MAQRAA rule
   * Handles: GOOD (+1/page), VERY_GOOD (+2/page), 5+ pages (+3/page override), MAQRAA (+1/page)
   */
  async getRecitationPoints(rating: string, pageCount: number): Promise<{ points: number; ruleNameAr: string } | null> {
    // ── FIX: Corrected enum value from NO_MEMORIZATION to DID_NOT_MEMORIZE ──
    if (!rating || rating === 'REPEAT' || rating === 'DID_NOT_MEMORIZE' || pageCount <= 0) {
      return null;
    }

    // ── FIX: Handle MAQRAA rating ──
    if (rating === 'MAQRAA') {
      const maqraaRule = await this.findByCode('RECITE_MAQRAA');
      if (maqraaRule && maqraaRule.isActive) {
        const pts = maqraaRule.isPerPage
          ? maqraaRule.points * pageCount
          : maqraaRule.points;
        return { points: pts, ruleNameAr: maqraaRule.nameAr };
      }
      return null;
    }

    // Check 5+ pages bonus first (applies to both GOOD and VERY_GOOD)
    if (pageCount >= 5) {
      const bonusRule = await this.findByCode('RECITE_5PLUS_PAGES');
      if (bonusRule && bonusRule.isActive && bonusRule.minPages && pageCount >= bonusRule.minPages) {
        return {
          points: bonusRule.points * pageCount,
          ruleNameAr: bonusRule.nameAr,
        };
      }
    }

    // Normal per-page rules
    const codeMap: Record<string, string> = {
      GOOD: 'RECITE_GOOD',
      VERY_GOOD: 'RECITE_VERY_GOOD',
    };

    const code = codeMap[rating];
    if (!code) return null;

    const rule = await this.findByCode(code);
    if (!rule || !rule.isActive) return null;

    return {
      points: rule.points * pageCount,
      ruleNameAr: rule.nameAr,
    };
  }

  /**
   * Get all manual rules (for instructor to apply)
   */
  async getManualRules() {
    const rules = await this.prisma.pointRule.findMany({
      where: { isAutomatic: false, isActive: true },
      orderBy: [{ points: 'desc' }],
    });
    return { data: rules };
  }
}