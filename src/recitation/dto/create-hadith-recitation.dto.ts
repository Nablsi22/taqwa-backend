import {
  IsString,
  IsInt,
  IsOptional,
  Matches,
  Min,
  Max,
} from 'class-validator';

// ═══════════════════════════════════════════════════════════════════
// HADITH RECITATION DTO — record one Nawawi-40-Hadith recitation
// ═══════════════════════════════════════════════════════════════════
//
// Nawawi's collection is 42 ahadith (40 + the 2 ibn-Rajab additions),
// matching the 42 rows in `hadith_points_rules`. No rating: points come
// from the rule's `base_points` snapshot. `term_id` is the active course.
// `date` (optional, like a recitation's) becomes the row's `created_at`;
// absent = now, which is what older APKs send.
//
export class CreateHadithRecitationDto {
  @IsString()
  studentId: string;

  @IsInt()
  @Min(1)
  @Max(42)
  hadithNumber: number;

  /** «تاريخ التسجيل» — 'YYYY-MM-DD'; range-checked by TermsService. */
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'صيغة التاريخ غير صحيحة' })
  date?: string;
}
