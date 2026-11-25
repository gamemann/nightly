-- Asset coverage: per row, the status of model / texture / sound / anim / icon / licence (lib/asset-coverage.mjs). Applied
-- idempotently by lib/asset-cols.mjs ensureColumns; filled by `nightly assets coverage` and after every scan / ingest.
ALTER TABLE "AssetWeapon" ADD COLUMN "coverage" TEXT NOT NULL DEFAULT '';
