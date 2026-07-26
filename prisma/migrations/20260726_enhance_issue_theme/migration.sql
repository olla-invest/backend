ALTER TABLE "theme_daily_snapshots"
  ADD COLUMN IF NOT EXISTS "short_term_rs" DECIMAL(5, 2),
  ADD COLUMN IF NOT EXISTS "momentum" DECIMAL(6, 2),
  ADD COLUMN IF NOT EXISTS "new_high_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "streak_direction" VARCHAR(10),
  ADD COLUMN IF NOT EXISTS "streak_days" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "theme_ai_summaries" (
  "summary_id" UUID NOT NULL,
  "theme_code" INTEGER NOT NULL,
  "trade_date" DATE NOT NULL,
  "summary" TEXT,
  "source_articles" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "model" VARCHAR(100),
  "prompt_version" VARCHAR(20) NOT NULL DEFAULT 'v1',
  "status" VARCHAR(20) NOT NULL,
  "error_message" TEXT,
  "generated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "theme_ai_summaries_pkey" PRIMARY KEY ("summary_id"),
  CONSTRAINT "theme_ai_summaries_theme_code_fkey"
    FOREIGN KEY ("theme_code") REFERENCES "themes"("theme_code")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "uk_theme_ai_summary_code_date"
  ON "theme_ai_summaries"("theme_code", "trade_date");

CREATE INDEX IF NOT EXISTS "idx_theme_ai_summary_latest"
  ON "theme_ai_summaries"("theme_code", "status", "trade_date" DESC);
