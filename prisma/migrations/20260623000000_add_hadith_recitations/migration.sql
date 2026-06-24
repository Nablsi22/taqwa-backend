-- Migration: add_hadith_recitations (al-Nawawi 42-hadith track).
-- Additive, idempotent. Reuses set_term_id_to_active() from add_terms_chapter.

BEGIN;

CREATE TABLE IF NOT EXISTS "hadith_points_rules" (
    "hadith_number" INTEGER      NOT NULL,
    "base_points"   INTEGER      NOT NULL,
    "title"         TEXT,
    "created_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hadith_points_rules_pkey" PRIMARY KEY ("hadith_number"),
    CONSTRAINT "hadith_points_rules_range_chk"  CHECK ("hadith_number" BETWEEN 1 AND 42),
    CONSTRAINT "hadith_points_rules_points_chk" CHECK ("base_points" > 0)
);

INSERT INTO "hadith_points_rules" ("hadith_number", "base_points") VALUES
    (1,1),(2,4),(3,1),(4,2),(5,1),(6,2),(7,1),(8,1),(9,1),(10,2),
    (11,1),(12,1),(13,1),(14,1),(15,1),(16,1),(17,1),(18,1),(19,3),(20,1),
    (21,1),(22,2),(23,1),(24,4),(25,3),(26,1),(27,2),(28,2),(29,4),(30,1),
    (31,1),(32,1),(33,1),(34,1),(35,2),(36,3),(37,2),(38,2),(39,1),(40,1),
    (41,1),(42,2)
ON CONFLICT ("hadith_number") DO UPDATE
    SET "base_points" = EXCLUDED."base_points", "updated_at" = CURRENT_TIMESTAMP;

INSERT INTO "point_categories"
    ("id", "name", "type", "default_value", "has_rating", "is_active", "created_at")
VALUES
    ('a0000000-0000-4000-8000-000000000040', 'Nawawi 40 Hadith',
     'EARN', 0, false, true, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "hadith_recitations" (
    "id"             TEXT         NOT NULL,
    "student_id"     TEXT         NOT NULL,
    "instructor_id"  TEXT         NOT NULL,
    "hadith_number"  INTEGER      NOT NULL,
    "points_awarded" INTEGER      NOT NULL,
    "term_id"        INTEGER,
    "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "hadith_recitations_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hadith_recitations_student_hadith_key" UNIQUE ("student_id", "hadith_number"),
    CONSTRAINT "hadith_recitations_student_id_fkey"
        FOREIGN KEY ("student_id") REFERENCES "students"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "hadith_recitations_hadith_number_fkey"
        FOREIGN KEY ("hadith_number") REFERENCES "hadith_points_rules"("hadith_number") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "hadith_recitations_term_id_fkey"
        FOREIGN KEY ("term_id") REFERENCES "terms"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "hadith_recitations_student_id_idx" ON "hadith_recitations" ("student_id");
CREATE INDEX IF NOT EXISTS "hadith_recitations_term_id_idx"    ON "hadith_recitations" ("term_id");

DROP TRIGGER IF EXISTS "hadith_recitations_set_term_id" ON "hadith_recitations";
CREATE TRIGGER "hadith_recitations_set_term_id"
  BEFORE INSERT ON "hadith_recitations"
  FOR EACH ROW EXECUTE FUNCTION set_term_id_to_active();

COMMIT;