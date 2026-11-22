-- One row per pack per audit ingest: AssetWeapon keeps only the latest audit per asset, this keeps the trend.
CREATE TABLE IF NOT EXISTS "AssetAuditHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "at" TEXT NOT NULL,
    "pack" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "pass" INTEGER NOT NULL DEFAULT 0,
    "avgScore" INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS "AssetAuditHistory_pack_at_idx" ON "AssetAuditHistory"("pack", "at");
