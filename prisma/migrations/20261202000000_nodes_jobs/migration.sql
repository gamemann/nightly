-- Node connection options and the offload job table.
ALTER TABLE "Node" ADD COLUMN "conn" TEXT NOT NULL DEFAULT '{}';

CREATE TABLE "NodeJob" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "jobKey" TEXT NOT NULL,
    "nodeId" INTEGER,
    "projectId" INTEGER,
    "buildId" INTEGER,
    "name" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'build',
    "command" TEXT NOT NULL DEFAULT '',
    "heavy" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "exitCode" INTEGER,
    "reason" TEXT NOT NULL DEFAULT '',
    "log" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME
);

CREATE UNIQUE INDEX "NodeJob_jobKey_key" ON "NodeJob"("jobKey");
CREATE INDEX "NodeJob_status_idx" ON "NodeJob"("status");
CREATE INDEX "NodeJob_nodeId_idx" ON "NodeJob"("nodeId");
