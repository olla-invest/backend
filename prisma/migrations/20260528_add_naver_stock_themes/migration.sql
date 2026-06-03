ALTER TABLE "themes"
  ADD COLUMN IF NOT EXISTS "source" VARCHAR(30) NOT NULL DEFAULT 'LEGACY',
  ADD COLUMN IF NOT EXISTS "source_theme_no" VARCHAR(50);

CREATE TABLE IF NOT EXISTS "stock_themes" (
  "theme_code" INTEGER NOT NULL,
  "stock_code" VARCHAR(20) NOT NULL,
  "stock_name" VARCHAR(100),
  "inclusion_reason" TEXT,
  "source" VARCHAR(30) NOT NULL DEFAULT 'NAVER',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "stock_themes_pkey" PRIMARY KEY ("theme_code", "stock_code"),
  CONSTRAINT "stock_themes_theme_code_fkey" FOREIGN KEY ("theme_code") REFERENCES "themes"("theme_code") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "uk_themes_source_theme_no" ON "themes"("source", "source_theme_no");
CREATE INDEX IF NOT EXISTS "idx_themes_source" ON "themes"("source");
CREATE INDEX IF NOT EXISTS "idx_stock_themes_stock_code" ON "stock_themes"("stock_code");
CREATE INDEX IF NOT EXISTS "idx_stock_themes_theme_code" ON "stock_themes"("theme_code");
CREATE INDEX IF NOT EXISTS "idx_stock_themes_source" ON "stock_themes"("source");
