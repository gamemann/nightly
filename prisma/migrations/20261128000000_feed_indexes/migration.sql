-- Sort indexes for the paged feed tables (newest first by `at`). Run by lib/feeds.mjs ensure() after the feeds migration, so the
-- tables always exist; the names match what Prisma gives the @@index entries in schema.prisma, so `prisma db push` finds them in place.
CREATE INDEX IF NOT EXISTS "Release_at_idx" ON "Release"("at");
CREATE INDEX IF NOT EXISTS "CrashGroup_at_idx" ON "CrashGroup"("at");
CREATE INDEX IF NOT EXISTS "WebSample_at_idx" ON "WebSample"("at");
CREATE INDEX IF NOT EXISTS "Playtest_at_idx" ON "Playtest"("at");
