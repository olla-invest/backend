ALTER TABLE "theme_daily_snapshots"
  ADD COLUMN IF NOT EXISTS "theme_score" DECIMAL(6, 2) NOT NULL DEFAULT 0;
