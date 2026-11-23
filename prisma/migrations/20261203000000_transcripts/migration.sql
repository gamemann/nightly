-- CreateTable
CREATE TABLE "Transcript" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "uid" TEXT NOT NULL,
    "nodeId" INTEGER,
    "osUser" TEXT NOT NULL DEFAULT '',
    "sessionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL DEFAULT '',
    "parentId" INTEGER,
    "agentType" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "toolUseId" TEXT NOT NULL DEFAULT '',
    "title" TEXT NOT NULL DEFAULT '',
    "cwd" TEXT NOT NULL DEFAULT '',
    "projectSlug" TEXT,
    "gitBranch" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "filePath" TEXT NOT NULL,
    "offset" INTEGER NOT NULL DEFAULT 0,
    "size" INTEGER NOT NULL DEFAULT 0,
    "mtimeMs" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TEXT NOT NULL DEFAULT '',
    "lastAt" TEXT NOT NULL DEFAULT '',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "toolCount" INTEGER NOT NULL DEFAULT 0,
    "inTokens" INTEGER NOT NULL DEFAULT 0,
    "outTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'idle',
    "source" TEXT NOT NULL DEFAULT 'cli',
    "ownerUserId" INTEGER,
    "forkedFrom" TEXT NOT NULL DEFAULT '',
    "state" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TEXT NOT NULL DEFAULT '',
    "updatedAt" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "TranscriptMessage" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "transcriptId" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "uuid" TEXT NOT NULL DEFAULT '',
    "parentUuid" TEXT NOT NULL DEFAULT '',
    "msgId" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'text',
    "ts" TEXT NOT NULL DEFAULT '',
    "byteStart" INTEGER NOT NULL,
    "byteLen" INTEGER NOT NULL,
    "model" TEXT NOT NULL DEFAULT '',
    "sidechain" INTEGER NOT NULL DEFAULT 0,
    "meta" INTEGER NOT NULL DEFAULT 0,
    "inTok" INTEGER NOT NULL DEFAULT 0,
    "outTok" INTEGER NOT NULL DEFAULT 0,
    "cacheRead" INTEGER NOT NULL DEFAULT 0,
    "cacheWrite" INTEGER NOT NULL DEFAULT 0,
    "tools" TEXT NOT NULL DEFAULT '[]',
    "toolUseIds" TEXT NOT NULL DEFAULT '[]',
    "spawnIds" TEXT NOT NULL DEFAULT '[]'
);

-- CreateTable
CREATE TABLE "TranscriptRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "transcriptId" INTEGER,
    "sessionId" TEXT NOT NULL DEFAULT '',
    "userId" INTEGER,
    "osUser" TEXT NOT NULL DEFAULT '',
    "nodeId" INTEGER,
    "pid" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'starting',
    "model" TEXT NOT NULL DEFAULT '',
    "effort" TEXT NOT NULL DEFAULT '',
    "permissionMode" TEXT NOT NULL DEFAULT 'default',
    "cwd" TEXT NOT NULL DEFAULT '',
    "resumeOf" TEXT NOT NULL DEFAULT '',
    "dir" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "exitCode" INTEGER,
    "startedAt" TEXT NOT NULL DEFAULT '',
    "endedAt" TEXT
);

-- CreateIndex
CREATE UNIQUE INDEX "Transcript_uid_key" ON "Transcript"("uid");

-- CreateIndex
CREATE UNIQUE INDEX "Transcript_filePath_key" ON "Transcript"("filePath");

-- CreateIndex
CREATE INDEX "Transcript_lastAt_idx" ON "Transcript"("lastAt");

-- CreateIndex
CREATE INDEX "Transcript_sessionId_idx" ON "Transcript"("sessionId");

-- CreateIndex
CREATE INDEX "Transcript_parentId_idx" ON "Transcript"("parentId");

-- CreateIndex
CREATE INDEX "Transcript_toolUseId_idx" ON "Transcript"("toolUseId");

-- CreateIndex
CREATE INDEX "TranscriptMessage_transcriptId_seq_idx" ON "TranscriptMessage"("transcriptId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptMessage_transcriptId_byteStart_key" ON "TranscriptMessage"("transcriptId", "byteStart");

-- CreateIndex
CREATE INDEX "TranscriptRun_status_idx" ON "TranscriptRun"("status");

-- CreateIndex
CREATE INDEX "TranscriptRun_transcriptId_idx" ON "TranscriptRun"("transcriptId");

