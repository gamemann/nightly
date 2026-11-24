-- Asset-to-asset attachments: a weapon (or any asset) links to attachment assets, each with a mount slot and the transform
-- (in the parent model's space) the game uses. Both ends are AssetWeapon rows; deleting either end drops the link.
CREATE TABLE IF NOT EXISTS "AssetAttachment" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "parentId" INTEGER NOT NULL,
    "attachmentId" INTEGER NOT NULL,
    "slot" TEXT NOT NULL,
    "px" REAL NOT NULL DEFAULT 0,
    "py" REAL NOT NULL DEFAULT 0,
    "pz" REAL NOT NULL DEFAULT 0,
    "rx" REAL NOT NULL DEFAULT 0,
    "ry" REAL NOT NULL DEFAULT 0,
    "rz" REAL NOT NULL DEFAULT 0,
    "sx" REAL NOT NULL DEFAULT 1,
    "sy" REAL NOT NULL DEFAULT 1,
    "sz" REAL NOT NULL DEFAULT 1,
    "node" TEXT NOT NULL DEFAULT '',
    "meta" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "AssetAttachment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "AssetWeapon" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AssetAttachment_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "AssetWeapon" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "AssetAttachment_parentId_attachmentId_slot_key" ON "AssetAttachment"("parentId", "attachmentId", "slot");
CREATE INDEX IF NOT EXISTS "AssetAttachment_attachmentId_idx" ON "AssetAttachment"("attachmentId");
