-- RSI flag definitions: what the board does with an audit flag code. `match` is a regex over the code; the first row (by sort)
-- with a non-empty domain decides the board domain, the first with a non-empty action gives the finding's next action.
-- Generic rows are seeded by lib/rsi-flags.mjs when the table is created; edit them with `nightly rsi flag` or /assets/sources.
CREATE TABLE IF NOT EXISTS "RsiFlag" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "match" TEXT NOT NULL,
    "domain" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL DEFAULT '',
    "label" TEXT NOT NULL DEFAULT '',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS "RsiFlag_match_key" ON "RsiFlag"("match");
