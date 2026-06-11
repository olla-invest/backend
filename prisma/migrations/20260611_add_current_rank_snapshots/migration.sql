-- Add current rank final column to daily metrics.
ALTER TABLE "stock_daily_metrics"
ADD COLUMN "current_rank" INTEGER;

CREATE INDEX "idx_stock_metrics_date_current_rank"
ON "stock_daily_metrics"("trade_date", "current_rank");

-- Store intraday rankings calculated from current price + DF filters.
CREATE TABLE "stock_current_rank_snapshots" (
    "snapshot_id" UUID NOT NULL,
    "stock_code" VARCHAR(20) NOT NULL,
    "trade_date" DATE NOT NULL,
    "snapshot_time" TIMESTAMP(3) NOT NULL,
    "current_rank" INTEGER,
    "relative_strength_score" DECIMAL(5,2) NOT NULL,
    "current_price" DECIMAL(15,2) NOT NULL,
    "close_price" DECIMAL(15,2) NOT NULL,
    "high_price_52w" DECIMAL(15,2),
    "low_price_52w" DECIMAL(15,2),
    "ma_50" DECIMAL(15,2),
    "passed_dynamic_filters" BOOLEAN NOT NULL DEFAULT false,
    "price_source" VARCHAR(20) NOT NULL DEFAULT 'close',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_current_rank_snapshots_pkey" PRIMARY KEY ("snapshot_id")
);

CREATE UNIQUE INDEX "uk_current_rank_snapshot"
ON "stock_current_rank_snapshots"("trade_date", "snapshot_time", "stock_code");

CREATE INDEX "idx_current_rank_snapshot_rank"
ON "stock_current_rank_snapshots"("trade_date", "snapshot_time", "current_rank");

CREATE INDEX "idx_current_rank_snapshot_stock"
ON "stock_current_rank_snapshots"("stock_code", "trade_date" DESC, "snapshot_time" DESC);
