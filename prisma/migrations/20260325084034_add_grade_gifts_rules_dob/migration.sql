/*
  Warnings:

  - You are about to drop the column `age` on the `instructors` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "instructors" DROP COLUMN "age",
ADD COLUMN     "date_of_birth" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "students" ADD COLUMN     "grade" TEXT;

-- CreateTable
CREATE TABLE "point_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "name_ar" TEXT NOT NULL,
    "description" TEXT,
    "rating_condition" "RecitationRating",
    "min_pages" INTEGER,
    "points_per_page" INTEGER NOT NULL DEFAULT 0,
    "bonus_points" INTEGER NOT NULL DEFAULT 0,
    "type" "PointType" NOT NULL DEFAULT 'EARN',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "point_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gifts" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_data" TEXT,
    "points_cost" INTEGER NOT NULL,
    "is_available" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gifts_pkey" PRIMARY KEY ("id")
);
