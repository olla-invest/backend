ALTER TABLE "theme_daily_snapshots"
  ADD COLUMN IF NOT EXISTS "avg_rs_score" DECIMAL(5, 2) NOT NULL DEFAULT 0;
