ALTER TABLE "stock_current_rank_snapshots"
  ADD COLUMN "price_change_rate" DECIMAL(10, 4),
  ADD COLUMN "trading_value" BIGINT,
  ADD COLUMN "previous_trading_value_ratio" DECIMAL(12, 4),
  ADD COLUMN "is_new_high" BOOLEAN,
  ADD COLUMN "short_term_rs" DECIMAL(5, 2);

ALTER TABLE "theme_daily_snapshots"
  ADD COLUMN "stock_snapshot_time" TIMESTAMP;

CREATE INDEX "idx_theme_snapshot_stock_source"
  ON "theme_daily_snapshots"("snapshot_date", "stock_snapshot_time");
