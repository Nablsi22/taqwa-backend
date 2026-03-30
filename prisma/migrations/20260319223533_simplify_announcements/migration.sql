/*
  Warnings:

  - You are about to drop the column `priority` on the `announcements` table. All the data in the column will be lost.
  - You are about to drop the column `target_role` on the `announcements` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "announcements" DROP COLUMN "priority",
DROP COLUMN "target_role";
