CREATE TABLE "market_view_daily_snapshots" (
    "snapshot_id" UUID NOT NULL,
    "market_type" VARCHAR(10) NOT NULL,
    "trade_date" DATE NOT NULL,
    "index_open" DECIMAL(12,2) NOT NULL,
    "index_high" DECIMAL(12,2) NOT NULL,
    "index_low" DECIMAL(12,2) NOT NULL,
    "index_close" DECIMAL(12,2) NOT NULL,
    "index_change" DECIMAL(12,2) NOT NULL,
    "index_change_rate" DECIMAL(8,4) NOT NULL,
    "volume" BIGINT NOT NULL,
    "rising_count" INTEGER NOT NULL,
    "flat_count" INTEGER NOT NULL,
    "falling_count" INTEGER NOT NULL,
    "upper_limit_count" INTEGER NOT NULL DEFAULT 0,
    "lower_limit_count" INTEGER NOT NULL DEFAULT 0,
    "foreign_net_buy" DECIMAL(20,2) NOT NULL,
    "institution_net_buy" DECIMAL(20,2) NOT NULL,
    "individual_net_buy" DECIMAL(20,2) NOT NULL,
    "ma20" DECIMAL(12,2),
    "ma50" DECIMAL(12,2),
    "ma200" DECIMAL(12,2),
    "below_ma20_ratio" DECIMAL(6,2) NOT NULL,
    "below_ma200_ratio" DECIMAL(6,2) NOT NULL,
    "adr" DECIMAL(10,4),
    "new_high_count" INTEGER NOT NULL,
    "new_low_count" INTEGER NOT NULL,
    "net_new_high" INTEGER NOT NULL,
    "is_distribution_day" BOOLEAN NOT NULL DEFAULT false,
    "distribution_count" INTEGER NOT NULL DEFAULT 0,
    "distribution_accelerating" BOOLEAN NOT NULL DEFAULT false,
    "rally_day" INTEGER,
    "rally_start_date" DATE,
    "rally_attempt_low" DECIMAL(12,2),
    "is_follow_through_day" BOOLEAN NOT NULL DEFAULT false,
    "follow_through_date" DATE,
    "short_signal" VARCHAR(10) NOT NULL,
    "long_signal" VARCHAR(10) NOT NULL,
    "market_state" VARCHAR(30) NOT NULL,
    "exposure_min" INTEGER NOT NULL,
    "exposure_max" INTEGER NOT NULL,
    "alert_code" VARCHAR(50) NOT NULL,
    "alert_message" VARCHAR(500) NOT NULL,
    "data_status" VARCHAR(20) NOT NULL DEFAULT 'NORMAL',
    "delayed_message" VARCHAR(500),
    "source_trade_date" DATE NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_view_daily_snapshots_pkey" PRIMARY KEY ("snapshot_id")
);

CREATE TABLE "market_view_distribution_days" (
    "distribution_id" UUID NOT NULL,
    "market_type" VARCHAR(10) NOT NULL,
    "trade_date" DATE NOT NULL,
    "change_rate" DECIMAL(8,4) NOT NULL,
    "volume" BIGINT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "removed_reason" VARCHAR(30),
    "removed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_view_distribution_days_pkey" PRIMARY KEY ("distribution_id")
);

CREATE UNIQUE INDEX "uk_market_view_snapshot_market_date"
ON "market_view_daily_snapshots"("market_type", "trade_date");

CREATE INDEX "idx_market_view_snapshot_date"
ON "market_view_daily_snapshots"("trade_date" DESC);

CREATE INDEX "idx_market_view_snapshot_market_date"
ON "market_view_daily_snapshots"("market_type", "trade_date" DESC);

CREATE UNIQUE INDEX "uk_market_view_distribution_market_date"
ON "market_view_distribution_days"("market_type", "trade_date");

CREATE INDEX "idx_market_view_distribution_active"
ON "market_view_distribution_days"("market_type", "is_active", "trade_date" DESC);
