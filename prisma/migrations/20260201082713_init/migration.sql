-- CreateEnum
CREATE TYPE "market_type_enum" AS ENUM ('KOSPI', 'KOSDAQ', '기타시장');

-- CreateEnum
CREATE TYPE "market_index_type" AS ENUM ('KOSPI', 'KOSDAQ');

-- CreateEnum
CREATE TYPE "batch_job_type" AS ENUM ('STOCK_PRICE', 'MARKET_INDEX', 'RS_CALCULATION');

-- CreateEnum
CREATE TYPE "batch_job_status" AS ENUM ('RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "user_id" UUID NOT NULL,
    "username" VARCHAR(50) NOT NULL,
    "email" VARCHAR(100) NOT NULL,
    "password" VARCHAR(255) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "companies" (
    "company_id" UUID NOT NULL,
    "company_name" VARCHAR(100) NOT NULL,
    "stock_code" VARCHAR(20) NOT NULL,
    "market_type" "market_type_enum" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "companies_pkey" PRIMARY KEY ("company_id")
);

-- CreateTable
CREATE TABLE "user_watchlist" (
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "added_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "memo" TEXT,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "user_watchlist_pkey" PRIMARY KEY ("user_id","company_id")
);

-- CreateTable
CREATE TABLE "tags" (
    "tag_id" UUID NOT NULL,
    "tag_name" VARCHAR(50) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "tags_pkey" PRIMARY KEY ("tag_id")
);

-- CreateTable
CREATE TABLE "watchlist_tags" (
    "user_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "watchlist_tags_pkey" PRIMARY KEY ("user_id","company_id","tag_id")
);

-- CreateTable
CREATE TABLE "rs_filter_presets" (
    "preset_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "preset_name" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "rs_filter_presets_pkey" PRIMARY KEY ("preset_id")
);

-- CreateTable
CREATE TABLE "rs_filter_periods" (
    "period_id" UUID NOT NULL,
    "preset_id" UUID NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "weight_ratio" DECIMAL(5,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "rs_filter_periods_pkey" PRIMARY KEY ("period_id")
);

-- CreateTable
CREATE TABLE "search_filter_presets" (
    "filter_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "filter_name" VARCHAR(100) NOT NULL,
    "filter_config" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "search_filter_presets_pkey" PRIMARY KEY ("filter_id")
);

-- CreateTable
CREATE TABLE "stock_price_history" (
    "price_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "trade_date" DATE NOT NULL,
    "open_price" DECIMAL(15,2) NOT NULL,
    "high_price" DECIMAL(15,2) NOT NULL,
    "low_price" DECIMAL(15,2) NOT NULL,
    "close_price" DECIMAL(15,2) NOT NULL,
    "volume" BIGINT NOT NULL,
    "trading_value" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_price_history_pkey" PRIMARY KEY ("price_id")
);

-- CreateTable
CREATE TABLE "market_index_history" (
    "index_id" UUID NOT NULL,
    "market_type" "market_index_type" NOT NULL,
    "trade_date" DATE NOT NULL,
    "close_index" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "market_index_history_pkey" PRIMARY KEY ("index_id")
);

-- CreateTable
CREATE TABLE "kiwoom_api_call_log" (
    "log_id" UUID NOT NULL,
    "user_id" UUID,
    "api_name" VARCHAR(50) NOT NULL,
    "stock_code" VARCHAR(20),
    "request_data" JSONB,
    "response_status" VARCHAR(20),
    "response_message" TEXT,
    "call_timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "response_time_ms" INTEGER,

    CONSTRAINT "kiwoom_api_call_log_pkey" PRIMARY KEY ("log_id")
);

-- CreateTable
CREATE TABLE "batch_job_history" (
    "job_id" UUID NOT NULL,
    "job_type" "batch_job_type" NOT NULL,
    "target_date" DATE NOT NULL,
    "status" "batch_job_status" NOT NULL,
    "start_time" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "end_time" TIMESTAMP(3),
    "processed_count" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,

    CONSTRAINT "batch_job_history_pkey" PRIMARY KEY ("job_id")
);

-- CreateIndex
CREATE INDEX "idx_users_username" ON "users"("username");

-- CreateIndex
CREATE INDEX "idx_users_email" ON "users"("email");

-- CreateIndex
CREATE INDEX "idx_users_deleted_at" ON "users"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_users_username" ON "users"("username", "deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_users_email" ON "users"("email", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_companies_stock_code" ON "companies"("stock_code");

-- CreateIndex
CREATE INDEX "idx_companies_market_type" ON "companies"("market_type");

-- CreateIndex
CREATE INDEX "idx_companies_company_name" ON "companies"("company_name");

-- CreateIndex
CREATE INDEX "idx_companies_deleted_at" ON "companies"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_companies_stock_code" ON "companies"("stock_code", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_watchlist_user_added_date" ON "user_watchlist"("user_id", "added_date");

-- CreateIndex
CREATE INDEX "idx_watchlist_company_id" ON "user_watchlist"("company_id");

-- CreateIndex
CREATE INDEX "idx_watchlist_deleted_at" ON "user_watchlist"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_tags_tag_name" ON "tags"("tag_name");

-- CreateIndex
CREATE INDEX "idx_tags_deleted_at" ON "tags"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_tags_tag_name" ON "tags"("tag_name", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_watchlist_tags_tag_id" ON "watchlist_tags"("tag_id");

-- CreateIndex
CREATE INDEX "idx_watchlist_tags_user_company" ON "watchlist_tags"("user_id", "company_id");

-- CreateIndex
CREATE INDEX "idx_watchlist_tags_deleted_at" ON "watchlist_tags"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_rs_presets_user_id" ON "rs_filter_presets"("user_id");

-- CreateIndex
CREATE INDEX "idx_rs_presets_deleted_at" ON "rs_filter_presets"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_rs_presets_user_name" ON "rs_filter_presets"("user_id", "preset_name", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_rs_periods_preset_id" ON "rs_filter_periods"("preset_id");

-- CreateIndex
CREATE INDEX "idx_rs_periods_deleted_at" ON "rs_filter_periods"("deleted_at");

-- CreateIndex
CREATE INDEX "idx_search_presets_user_id" ON "search_filter_presets"("user_id");

-- CreateIndex
CREATE INDEX "idx_search_presets_deleted_at" ON "search_filter_presets"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "uk_search_presets_user_name" ON "search_filter_presets"("user_id", "filter_name", "deleted_at");

-- CreateIndex
CREATE INDEX "idx_stock_price_company_date" ON "stock_price_history"("company_id", "trade_date" DESC);

-- CreateIndex
CREATE INDEX "idx_stock_price_trade_date" ON "stock_price_history"("trade_date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_stock_price_company_date" ON "stock_price_history"("company_id", "trade_date");

-- CreateIndex
CREATE INDEX "idx_market_index_type_date" ON "market_index_history"("market_type", "trade_date" DESC);

-- CreateIndex
CREATE INDEX "idx_market_index_trade_date" ON "market_index_history"("trade_date");

-- CreateIndex
CREATE UNIQUE INDEX "uk_market_index_date" ON "market_index_history"("market_type", "trade_date");

-- CreateIndex
CREATE INDEX "idx_api_log_user_id" ON "kiwoom_api_call_log"("user_id");

-- CreateIndex
CREATE INDEX "idx_api_log_api_name" ON "kiwoom_api_call_log"("api_name");

-- CreateIndex
CREATE INDEX "idx_api_log_call_timestamp" ON "kiwoom_api_call_log"("call_timestamp");

-- CreateIndex
CREATE INDEX "idx_api_log_stock_code" ON "kiwoom_api_call_log"("stock_code");

-- CreateIndex
CREATE INDEX "idx_batch_job_type" ON "batch_job_history"("job_type");

-- CreateIndex
CREATE INDEX "idx_batch_target_date" ON "batch_job_history"("target_date");

-- CreateIndex
CREATE INDEX "idx_batch_status" ON "batch_job_history"("status");

-- AddForeignKey
ALTER TABLE "user_watchlist" ADD CONSTRAINT "user_watchlist_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_watchlist" ADD CONSTRAINT "user_watchlist_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_tags" ADD CONSTRAINT "watchlist_tags_user_id_company_id_fkey" FOREIGN KEY ("user_id", "company_id") REFERENCES "user_watchlist"("user_id", "company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watchlist_tags" ADD CONSTRAINT "watchlist_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("tag_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rs_filter_presets" ADD CONSTRAINT "rs_filter_presets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rs_filter_periods" ADD CONSTRAINT "rs_filter_periods_preset_id_fkey" FOREIGN KEY ("preset_id") REFERENCES "rs_filter_presets"("preset_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "search_filter_presets" ADD CONSTRAINT "search_filter_presets_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_price_history" ADD CONSTRAINT "stock_price_history_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "companies"("company_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "kiwoom_api_call_log" ADD CONSTRAINT "kiwoom_api_call_log_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("user_id") ON DELETE SET NULL ON UPDATE CASCADE;
