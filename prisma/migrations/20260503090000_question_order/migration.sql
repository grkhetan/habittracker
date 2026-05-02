ALTER TABLE "Question" ADD COLUMN "orderIndex" INTEGER NOT NULL DEFAULT 0;

WITH ordered_questions AS (
    SELECT "id", (ROW_NUMBER() OVER (ORDER BY "createdAt" ASC) * 10) AS position
    FROM "Question"
)
UPDATE "Question"
SET "orderIndex" = ordered_questions.position
FROM ordered_questions
WHERE "Question"."id" = ordered_questions."id";
