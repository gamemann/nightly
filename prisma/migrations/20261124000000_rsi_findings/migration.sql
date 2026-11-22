-- RSI board: one finding per (subject, code, tier). Asset findings come from the audit (auto-created, auto-closed when the flag
-- passes); process findings (domain 'process') are stale / duplicate / blocked items. Created idempotently by lib/rsi.mjs.
CREATE TABLE IF NOT EXISTS "RsiFinding" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "domain" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "assetId" INTEGER,
    "code" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT '',
    "severity" TEXT NOT NULL DEFAULT 'warn',
    "msg" TEXT NOT NULL DEFAULT '',
    "nextAction" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT 'found',
    "status" TEXT NOT NULL DEFAULT 'open',
    "beforeScore" REAL,
    "afterScore" REAL,
    "itemKey" TEXT NOT NULL DEFAULT '',
    "firstSeenAt" DATETIME NOT NULL,
    "lastSeenAt" DATETIME NOT NULL,
    "fixedAt" DATETIME,
    "history" TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS "RsiFinding_subject_code_tier_key" ON "RsiFinding"("subject", "code", "tier");
CREATE INDEX IF NOT EXISTS "RsiFinding_domain_status_idx" ON "RsiFinding"("domain", "status");
