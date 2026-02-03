-- CreateTable
CREATE TABLE "stock_daily_metrics" (
    "metric_id" UUID NOT NULL,
    "stock_code" VARCHAR(20) NOT NULL,
    "trade_date" DATE NOT NULL,
    "close_price" DECIMAL(15,2) NOT NULL,
    "relative_strength_score" DECIMAL(5,2) NOT NULL,
    "rank" INTEGER NOT NULL,
    "market_type" VARCHAR(10) NOT NULL,
    "is_new_high" BOOLEAN NOT NULL DEFAULT false,
    "high_price_52w" DECIMAL(15,2),
    "low_price_52w" DECIMAL(15,2),
    "price_change_1d" DECIMAL(15,2),
    "price_change_rate_1d" DECIMAL(10,4),
    "volume_1d" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_daily_metrics_pkey" PRIMARY KEY ("metric_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_stock_metrics_code_date" ON "stock_daily_metrics"("stock_code", "trade_date");

-- CreateIndex
CREATE INDEX "idx_stock_metrics_date_market_rank" ON "stock_daily_metrics"("trade_date", "market_type", "rank");

-- CreateIndex
CREATE INDEX "idx_stock_metrics_code_date" ON "stock_daily_metrics"("stock_code", "trade_date" DESC);

-- CreateIndex
CREATE INDEX "idx_stock_metrics_market_date" ON "stock_daily_metrics"("market_type", "trade_date");
