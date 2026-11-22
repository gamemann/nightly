-- ASSETS (RSI) tab: one row per weapon model/pack entry with its audit record (JSON). Applied by `nightly assets migrate`.
CREATE TABLE IF NOT EXISTS "AssetWeapon" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pack" TEXT NOT NULL,
    "game" TEXT NOT NULL DEFAULT '',
    "weaponId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'weapon',
    "source" TEXT NOT NULL DEFAULT 'scan',
    "tris" INTEGER NOT NULL DEFAULT 0,
    "texCount" INTEGER NOT NULL DEFAULT 0,
    "animCount" INTEGER NOT NULL DEFAULT 0,
    "soundCount" INTEGER NOT NULL DEFAULT 0,
    "flagCount" INTEGER NOT NULL DEFAULT 0,
    "flagCodes" TEXT NOT NULL DEFAULT '',
    "score" INTEGER NOT NULL DEFAULT 0,
    "pass" INTEGER NOT NULL DEFAULT 0,
    "auditedAt" TEXT NOT NULL DEFAULT '',
    "updatedAt" TEXT NOT NULL DEFAULT '',
    "data" TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetWeapon_pack_weaponId_key" ON "AssetWeapon"("pack", "weaponId");
CREATE INDEX IF NOT EXISTS "AssetWeapon_game_idx" ON "AssetWeapon"("game");
