-- PERFORMANCE tab, part 2: ingest tokens, finding kinds and the RSI loop. Applied by `nightly perf migrate`, one statement at a time:
-- an ALTER whose column already exists (a DB built by `npm run db:push`) is skipped, so this is safe to run twice.
CREATE TABLE IF NOT EXISTS "PerfToken" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "game" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME
);
CREATE UNIQUE INDEX IF NOT EXISTS "PerfToken_name_key" ON "PerfToken"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "PerfToken_hash_key" ON "PerfToken"("hash");
ALTER TABLE "PerfFinding" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'budget';
ALTER TABLE "PerfFinding" ADD COLUMN "state" TEXT NOT NULL DEFAULT 'found';
ALTER TABLE "PerfFinding" ADD COLUMN "fn" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PerfFinding" ADD COLUMN "scope" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PerfFinding" ADD COLUMN "beforeValue" REAL;
ALTER TABLE "PerfFinding" ADD COLUMN "afterValue" REAL;
ALTER TABLE "PerfFinding" ADD COLUMN "fixedAt" DATETIME;
ALTER TABLE "PerfFinding" ADD COLUMN "remeasuredRunId" INTEGER;
ALTER TABLE "PerfFinding" ADD COLUMN "remeasuredAt" DATETIME;
ALTER TABLE "PerfFinding" ADD COLUMN "history" TEXT NOT NULL DEFAULT '[]';
