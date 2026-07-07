CREATE TABLE "market_view_index_chart_points" (
    "point_id" UUID NOT NULL,
    "market_type" VARCHAR(10) NOT NULL,
    "trade_date" DATE NOT NULL,
    "trade_time" TIMESTAMP(3) NOT NULL,
    "index_price" DECIMAL(12,2) NOT NULL,
    "volume" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_view_index_chart_points_pkey" PRIMARY KEY ("point_id")
);

CREATE UNIQUE INDEX "uk_market_view_index_chart_market_time"
ON "market_view_index_chart_points"("market_type", "trade_date", "trade_time");

CREATE INDEX "idx_market_view_index_chart_query"
ON "market_view_index_chart_points"("market_type", "trade_date", "trade_time");
