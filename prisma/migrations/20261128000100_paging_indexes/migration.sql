-- Indexes for the paged Agents claims table, the message author filter and the QA list. Prisma tables, so applied by
-- `prisma db push` from the @@index entries in schema.prisma; the SQL is listed here for tooling.
CREATE INDEX IF NOT EXISTS "Claim_agentId_releasedAt_idx" ON "Claim"("agentId", "releasedAt");
CREATE INDEX IF NOT EXISTS "Message_author_idx" ON "Message"("author");
CREATE INDEX IF NOT EXISTS "QaRun_ranAt_idx" ON "QaRun"("ranAt");
