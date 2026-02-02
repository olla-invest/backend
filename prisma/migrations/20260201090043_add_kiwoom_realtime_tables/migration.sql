-- CreateTable
CREATE TABLE "kiwoom_tokens" (
    "token_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "token_type" VARCHAR(20) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "kiwoom_tokens_pkey" PRIMARY KEY ("token_id")
);

-- CreateTable
CREATE TABLE "stock_candles" (
    "candle_id" UUID NOT NULL,
    "stock_code" VARCHAR(20) NOT NULL,
    "candle_type" VARCHAR(10) NOT NULL,
    "candle_time" TIMESTAMP(3) NOT NULL,
    "open_price" DECIMAL(15,2) NOT NULL,
    "high_price" DECIMAL(15,2) NOT NULL,
    "low_price" DECIMAL(15,2) NOT NULL,
    "close_price" DECIMAL(15,2) NOT NULL,
    "volume" BIGINT NOT NULL,
    "trading_value" BIGINT,
    "prev_day_compare" DECIMAL(15,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_candles_pkey" PRIMARY KEY ("candle_id")
);

-- CreateTable
CREATE TABLE "stock_ticks" (
    "tick_id" UUID NOT NULL,
    "stock_code" VARCHAR(20) NOT NULL,
    "tick_time" TIMESTAMP(3) NOT NULL,
    "price" DECIMAL(15,2) NOT NULL,
    "volume" BIGINT NOT NULL,
    "prev_day_compare" DECIMAL(15,2),
    "change_rate" DECIMAL(10,4),
    "ask_price" DECIMAL(15,2),
    "bid_price" DECIMAL(15,2),
    "acc_volume" BIGINT,
    "acc_trading_value" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_ticks_pkey" PRIMARY KEY ("tick_id")
);

-- CreateTable
CREATE TABLE "stock_quotes" (
    "quote_id" UUID NOT NULL,
    "stock_code" VARCHAR(20) NOT NULL,
    "quote_time" TIMESTAMP(3) NOT NULL,
    "ask_price_1" DECIMAL(15,2),
    "ask_volume_1" BIGINT,
    "bid_price_1" DECIMAL(15,2),
    "bid_volume_1" BIGINT,
    "ask_price_2" DECIMAL(15,2),
    "ask_volume_2" BIGINT,
    "bid_price_2" DECIMAL(15,2),
    "bid_volume_2" BIGINT,
    "ask_price_3" DECIMAL(15,2),
    "ask_volume_3" BIGINT,
    "bid_price_3" DECIMAL(15,2),
    "bid_volume_3" BIGINT,
    "ask_price_4" DECIMAL(15,2),
    "ask_volume_4" BIGINT,
    "bid_price_4" DECIMAL(15,2),
    "bid_volume_4" BIGINT,
    "ask_price_5" DECIMAL(15,2),
    "ask_volume_5" BIGINT,
    "bid_price_5" DECIMAL(15,2),
    "bid_volume_5" BIGINT,
    "total_ask_volume" BIGINT,
    "total_bid_volume" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_quotes_pkey" PRIMARY KEY ("quote_id")
);

-- CreateIndex
CREATE INDEX "idx_kiwoom_token_expires_at" ON "kiwoom_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "idx_stock_candle_query" ON "stock_candles"("stock_code", "candle_type", "candle_time" DESC);

-- CreateIndex
CREATE INDEX "idx_stock_candle_time" ON "stock_candles"("candle_time");

-- CreateIndex
CREATE UNIQUE INDEX "uk_stock_candle" ON "stock_candles"("stock_code", "candle_type", "candle_time");

-- CreateIndex
CREATE INDEX "idx_stock_tick_query" ON "stock_ticks"("stock_code", "tick_time" DESC);

-- CreateIndex
CREATE INDEX "idx_stock_tick_time" ON "stock_ticks"("tick_time");

-- CreateIndex
CREATE INDEX "idx_stock_quote_query" ON "stock_quotes"("stock_code", "quote_time" DESC);

-- CreateIndex
CREATE INDEX "idx_stock_quote_time" ON "stock_quotes"("quote_time");
