-- Assets table paging: the numbers the table shows move out of the audit JSON into real columns so the page sorts, filters,
-- counts and charts in SQL. Applied (idempotently, with a backfill) by lib/asset-cols.mjs ensureColumns; `shape` = 0 marks rows
-- still to backfill. Listed here for Prisma tooling; the SQL below is what ensureColumns runs for a database without them.
ALTER TABLE "AssetWeapon" ADD COLUMN "hasModel" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssetWeapon" ADD COLUMN "verts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssetWeapon" ADD COLUMN "materials" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssetWeapon" ADD COLUMN "texMax" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssetWeapon" ADD COLUMN "texBytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssetWeapon" ADD COLUMN "texMaps" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AssetWeapon" ADD COLUMN "animLen" REAL NOT NULL DEFAULT 0;
ALTER TABLE "AssetWeapon" ADD COLUMN "soundLen" REAL NOT NULL DEFAULT 0;
ALTER TABLE "AssetWeapon" ADD COLUMN "soundBytes" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "AssetWeapon" ADD COLUMN "fileHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AssetWeapon" ADD COLUMN "shape" INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS "AssetWeapon_pack_idx" ON "AssetWeapon"("pack");
CREATE INDEX IF NOT EXISTS "AssetWeapon_score_idx" ON "AssetWeapon"("score");
CREATE INDEX IF NOT EXISTS "AssetWeapon_tris_idx" ON "AssetWeapon"("tris");
CREATE INDEX IF NOT EXISTS "AssetWeapon_kind_pack_idx" ON "AssetWeapon"("kind", "pack");
CREATE INDEX IF NOT EXISTS "Item_kind_status_idx" ON "Item"("kind", "status");
CREATE INDEX IF NOT EXISTS "Item_completedAt_idx" ON "Item"("completedAt");
CREATE INDEX IF NOT EXISTS "Item_updatedAt_idx" ON "Item"("updatedAt");
CREATE INDEX IF NOT EXISTS "Run_startedAt_idx" ON "Run"("startedAt");
CREATE INDEX IF NOT EXISTS "Run_status_idx" ON "Run"("status");
