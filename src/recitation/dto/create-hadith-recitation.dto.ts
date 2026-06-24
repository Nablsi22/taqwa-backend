import { IsString, IsInt, Min, Max } from 'class-validator';

// ═══════════════════════════════════════════════════════════════════
// HADITH RECITATION DTO — record one Nawawi-40-Hadith recitation
// ═══════════════════════════════════════════════════════════════════
//
// Nawawi's collection is 42 ahadith (40 + the 2 ibn-Rajab additions),
// matching the 42 rows in `hadith_points_rules`. No rating, no date:
// points come from the rule's `base_points` snapshot and the row's
// `created_at`/`term_id` are filled by the DB (default + trigger).
//
export class CreateHadithRecitationDto {
  @IsString()
  studentId: string;

  @IsInt()
  @Min(1)
  @Max(42)
  hadithNumber: number;
}
