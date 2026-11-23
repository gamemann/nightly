-- CreateTable
CREATE TABLE "ItemProject" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "itemId" INTEGER NOT NULL,
    "projectId" INTEGER NOT NULL,
    "via" TEXT NOT NULL DEFAULT 'slug',
    "token" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ItemProject_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ItemProject_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectPack" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "projectId" INTEGER NOT NULL,
    "pack" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "via" TEXT NOT NULL DEFAULT 'slug',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectPack_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ItemProject_projectId_idx" ON "ItemProject"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemProject_itemId_projectId_key" ON "ItemProject"("itemId", "projectId");

-- CreateIndex
CREATE INDEX "ProjectPack_pack_idx" ON "ProjectPack"("pack");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectPack_projectId_pack_key" ON "ProjectPack"("projectId", "pack");
