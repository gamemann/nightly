-- ASSETS: where assets come from (sources) and what kinds exist with their audit budgets. Applied by `nightly assets migrate`.
-- Both tables are configuration, edited in the panel (/assets/sources) or with `nightly assets source|kind ...`. The only rows
-- seeded are generic kinds (see lib/assets-kinds.mjs); sources are always added by the user.
CREATE TABLE IF NOT EXISTS "AssetSource" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'pack',
    "root" TEXT NOT NULL DEFAULT '',
    "repo" TEXT NOT NULL DEFAULT '',
    "enabled" INTEGER NOT NULL DEFAULT 1,
    "config" TEXT NOT NULL DEFAULT '{}',
    "lastScanAt" TEXT NOT NULL DEFAULT '',
    "createdAt" TEXT NOT NULL DEFAULT '',
    "updatedAt" TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetSource_name_key" ON "AssetSource"("name");
CREATE TABLE IF NOT EXISTS "AssetKind" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "match" TEXT NOT NULL DEFAULT '',
    "budget" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetKind_key_key" ON "AssetKind"("key");
CREATE INDEX IF NOT EXISTS "AssetWeapon_kind_idx" ON "AssetWeapon"("kind")
