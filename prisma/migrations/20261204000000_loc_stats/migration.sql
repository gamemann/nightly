-- CreateTable
CREATE TABLE IF NOT EXISTS "LocStat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "projectId" INTEGER NOT NULL,
    "scannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "code" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "blanks" INTEGER NOT NULL DEFAULT 0,
    "total" INTEGER NOT NULL DEFAULT 0,
    "files" INTEGER NOT NULL DEFAULT 0,
    "byLanguage" TEXT NOT NULL DEFAULT '[]',
    "sha" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "LocStat_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "LocStat_projectId_scannedAt_idx" ON "LocStat"("projectId", "scannedAt");
