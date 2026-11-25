-- A game row that is a byte-identical copy of a pack asset names that pack row ('<pack>/<weaponId>'); lists, counts and findings
-- use the pack row only (lib/assets-packrules.mjs). ensureColumns adds it too, so a DB that already has it is fine.
ALTER TABLE "AssetWeapon" ADD COLUMN "vendoredFrom" TEXT NOT NULL DEFAULT '';
