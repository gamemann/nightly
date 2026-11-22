-- Generic project-health feeds (releases, crashes, web checks, playtests, content stats). Created idempotently by lib/feeds.mjs.
CREATE TABLE IF NOT EXISTS "Release" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL DEFAULT '',
    "repo" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "commit" TEXT NOT NULL DEFAULT '',
    "ci" TEXT NOT NULL DEFAULT 'unknown',
    "deployedTo" TEXT NOT NULL DEFAULT '',
    "changelog" TEXT NOT NULL DEFAULT '',
    "rollback" TEXT NOT NULL DEFAULT '',
    "at" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "Release_repo_version_channel_key" ON "Release"("repo", "version", "channel");
CREATE TABLE IF NOT EXISTS "CrashGroup" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "signature" TEXT NOT NULL,
    "version" TEXT NOT NULL DEFAULT '',
    "platform" TEXT NOT NULL DEFAULT '',
    "count" INTEGER NOT NULL DEFAULT 1,
    "sample" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'open',
    "firstSeenAt" DATETIME NOT NULL,
    "at" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "CrashGroup_key" ON "CrashGroup"("game", "signature", "version", "platform");
CREATE TABLE IF NOT EXISTS "WebBudget" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "max" REAL NOT NULL,
    "unit" TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS "WebBudget_key" ON "WebBudget"("game", "metric");
CREATE TABLE IF NOT EXISTS "WebSample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',
    "commit" TEXT NOT NULL DEFAULT '',
    "at" DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS "WebSample_game_metric_at" ON "WebSample"("game", "metric", "at");
CREATE TABLE IF NOT EXISTS "Playtest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "build" TEXT NOT NULL DEFAULT '',
    "tester" TEXT NOT NULL DEFAULT '',
    "rating" INTEGER,
    "tags" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "at" DATETIME NOT NULL
);
CREATE TABLE IF NOT EXISTS "ContentStat" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "category" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "min" REAL,
    "max" REAL,
    "at" DATETIME NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ContentStat_key" ON "ContentStat"("game", "category", "name", "metric");
