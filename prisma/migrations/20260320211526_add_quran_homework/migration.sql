-- AlterTable
ALTER TABLE "quran_progress" ADD COLUMN     "did_not_memorize" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "homework" TEXT;
