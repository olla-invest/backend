CREATE TABLE "theme_group_themes" (
    "group_theme_code" INTEGER NOT NULL,
    "theme_code" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "theme_group_themes_pkey" PRIMARY KEY ("group_theme_code", "theme_code")
);

CREATE INDEX "idx_theme_group_themes_theme_code" ON "theme_group_themes"("theme_code");

ALTER TABLE "theme_group_themes"
    ADD CONSTRAINT "theme_group_themes_group_theme_code_fkey"
    FOREIGN KEY ("group_theme_code") REFERENCES "themes"("theme_code")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "theme_group_themes"
    ADD CONSTRAINT "theme_group_themes_theme_code_fkey"
    FOREIGN KEY ("theme_code") REFERENCES "themes"("theme_code")
    ON DELETE RESTRICT ON UPDATE CASCADE;
