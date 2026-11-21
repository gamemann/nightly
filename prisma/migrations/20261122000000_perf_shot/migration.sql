-- PERFORMANCE tab, part 3: screenshots attached to runs (png files live under the perf data dir). Applied by `nightly perf migrate`.
CREATE TABLE IF NOT EXISTS "PerfShot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "file" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PerfShot_runId_idx" ON "PerfShot"("runId");
