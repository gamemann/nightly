-- PERFORMANCE tab. Idempotent: applied by `nightly perf migrate` (or `npm run db:push`, which reaches the same shape).
CREATE TABLE IF NOT EXISTS "PerfGame" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "repo" TEXT NOT NULL DEFAULT '',
    "repoPath" TEXT NOT NULL DEFAULT '',
    "engine" TEXT NOT NULL DEFAULT 'godot',
    "platforms" TEXT NOT NULL DEFAULT 'native,web',
    "owner" TEXT NOT NULL DEFAULT '',
    "budgets" TEXT NOT NULL DEFAULT '[]',
    "routing" TEXT NOT NULL DEFAULT '{}',
    "addons" TEXT NOT NULL DEFAULT '{}',
    "perfScript" TEXT NOT NULL DEFAULT 'tools/perf.sh',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "PerfGame_slug_key" ON "PerfGame"("slug");
CREATE TABLE IF NOT EXISTS "PerfRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "commit" TEXT NOT NULL DEFAULT '',
    "build" TEXT NOT NULL DEFAULT '',
    "branch" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT 'native',
    "role" TEXT NOT NULL DEFAULT 'client',
    "map" TEXT NOT NULL DEFAULT '',
    "bots" INTEGER NOT NULL DEFAULT 0,
    "resolution" TEXT NOT NULL DEFAULT '',
    "gpu" TEXT NOT NULL DEFAULT '',
    "durationS" REAL NOT NULL DEFAULT 0,
    "frames" INTEGER NOT NULL DEFAULT 0,
    "ranAt" DATETIME NOT NULL,
    "source" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "reportVersion" INTEGER NOT NULL DEFAULT 0,
    "artefact" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "PerfRun_game_ranAt_idx" ON "PerfRun"("game", "ranAt");
CREATE INDEX IF NOT EXISTS "PerfRun_game_platform_role_map_ranAt_idx" ON "PerfRun"("game", "platform", "role", "map", "ranAt");
CREATE INDEX IF NOT EXISTS "PerfRun_commit_idx" ON "PerfRun"("commit");
CREATE TABLE IF NOT EXISTS "PerfMetric" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "value" REAL NOT NULL,
    CONSTRAINT "PerfMetric_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PerfRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PerfMetric_runId_idx" ON "PerfMetric"("runId");
CREATE INDEX IF NOT EXISTS "PerfMetric_name_runId_idx" ON "PerfMetric"("name", "runId");
CREATE TABLE IF NOT EXISTS "PerfFunc" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '',
    "per" TEXT NOT NULL DEFAULT 'frame',
    "grp" TEXT NOT NULL DEFAULT 'other',
    "addon" TEXT NOT NULL DEFAULT '',
    "selfMs" REAL NOT NULL DEFAULT 0,
    "totalMs" REAL NOT NULL DEFAULT 0,
    "calls" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "PerfFunc_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PerfRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "PerfFunc_runId_idx" ON "PerfFunc"("runId");
CREATE INDEX IF NOT EXISTS "PerfFunc_name_idx" ON "PerfFunc"("name");
CREATE TABLE IF NOT EXISTS "PerfFinding" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "runId" INTEGER,
    "itemKey" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "value" REAL NOT NULL DEFAULT 0,
    "limit" REAL NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "PerfFinding_game_metric_key" ON "PerfFinding"("game", "metric");
