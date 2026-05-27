-- CreateTable
CREATE TABLE "cron_run_log" (
    "run_id" UUID NOT NULL,
    "job_name" VARCHAR(80) NOT NULL,
    "trade_date" DATE NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    "duration_ms" INTEGER,
    "error_msg" TEXT,
    "metadata" JSONB,

    CONSTRAINT "cron_run_log_pkey" PRIMARY KEY ("run_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_cron_run_log_job_date" ON "cron_run_log"("job_name", "trade_date");

-- CreateIndex
CREATE INDEX "idx_cron_run_log_status" ON "cron_run_log"("job_name", "status", "trade_date" DESC);
