-- CreateTable
CREATE TABLE "Item" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "kind" TEXT NOT NULL DEFAULT 'task',
    "status" TEXT NOT NULL DEFAULT 'queue',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "repos" TEXT NOT NULL DEFAULT '',
    "doneWhen" TEXT,
    "addedBy" TEXT NOT NULL DEFAULT 'owner',
    "cadence" TEXT,
    "lastRunAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "completedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Note" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "itemId" INTEGER NOT NULL,
    "runId" INTEGER,
    "author" TEXT NOT NULL DEFAULT 'owner',
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Note_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Note_runId_fkey" FOREIGN KEY ("runId") REFERENCES "Run" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Run" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "status" TEXT NOT NULL DEFAULT 'running',
    "summary" TEXT NOT NULL DEFAULT '',
    "report" TEXT NOT NULL DEFAULT '',
    "log" TEXT NOT NULL DEFAULT '',
    "turns" INTEGER,
    "minutes" REAL,
    "costUsd" REAL,
    "trigger" TEXT NOT NULL DEFAULT 'cron',
    "pid" INTEGER,
    "scheduleId" INTEGER,
    CONSTRAINT "Run_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "Schedule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Schedule" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "cron" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "prompt" TEXT NOT NULL DEFAULT 'nightly.md',
    "instructions" TEXT NOT NULL DEFAULT '',
    "maxTurns" INTEGER NOT NULL DEFAULT 400,
    "allowOverlap" BOOLEAN NOT NULL DEFAULT false,
    "lastFiredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Agent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'session',
    "task" TEXT NOT NULL DEFAULT '',
    "repos" TEXT NOT NULL DEFAULT '',
    "runId" INTEGER,
    "lastReadId" INTEGER NOT NULL DEFAULT 0,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME
);

-- CreateTable
CREATE TABLE "Claim" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "agentId" INTEGER NOT NULL,
    "scope" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" DATETIME,
    CONSTRAINT "Claim_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Message" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "agentId" INTEGER,
    "author" TEXT NOT NULL,
    "to" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Message_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "Agent" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Prompt" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'prompt',
    "body" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "promptId" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT 'owner',
    "note" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PromptVersion_promptId_fkey" FOREIGN KEY ("promptId") REFERENCES "Prompt" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "QaRun" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "game" TEXT NOT NULL,
    "commit" TEXT NOT NULL DEFAULT '',
    "ranAt" DATETIME NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "summary" TEXT NOT NULL DEFAULT '{}',
    "failures" TEXT NOT NULL DEFAULT '[]',
    "images" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Annotation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "itemKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "x" REAL NOT NULL,
    "y" REAL NOT NULL,
    "z" REAL NOT NULL DEFAULT 0,
    "nx" REAL NOT NULL DEFAULT 0,
    "ny" REAL NOT NULL DEFAULT 0,
    "nz" REAL NOT NULL DEFAULT 0,
    "text" TEXT NOT NULL,
    "author" TEXT NOT NULL DEFAULT 'owner',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PerfGame" (
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

-- CreateTable
CREATE TABLE "PerfRun" (
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

-- CreateTable
CREATE TABLE "PerfMetric" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "value" REAL NOT NULL,
    CONSTRAINT "PerfMetric_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PerfRun" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PerfFunc" (
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

-- CreateTable
CREATE TABLE "PerfFinding" (
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
    "updatedAt" DATETIME NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'budget',
    "state" TEXT NOT NULL DEFAULT 'found',
    "fn" TEXT NOT NULL DEFAULT '',
    "scope" TEXT NOT NULL DEFAULT '',
    "beforeValue" REAL,
    "afterValue" REAL,
    "fixedAt" DATETIME,
    "remeasuredRunId" INTEGER,
    "remeasuredAt" DATETIME,
    "history" TEXT NOT NULL DEFAULT '[]'
);

-- CreateTable
CREATE TABLE "PerfToken" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT '',
    "game" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME
);

-- CreateTable
CREATE TABLE "PerfShot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "runId" INTEGER NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "file" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "AssetWeapon" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "pack" TEXT NOT NULL,
    "game" TEXT NOT NULL DEFAULT '',
    "weaponId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'weapon',
    "source" TEXT NOT NULL DEFAULT 'scan',
    "tris" INTEGER NOT NULL DEFAULT 0,
    "texCount" INTEGER NOT NULL DEFAULT 0,
    "animCount" INTEGER NOT NULL DEFAULT 0,
    "soundCount" INTEGER NOT NULL DEFAULT 0,
    "flagCount" INTEGER NOT NULL DEFAULT 0,
    "flagCodes" TEXT NOT NULL DEFAULT '',
    "score" INTEGER NOT NULL DEFAULT 0,
    "pass" INTEGER NOT NULL DEFAULT 0,
    "auditedAt" TEXT NOT NULL DEFAULT '',
    "updatedAt" TEXT NOT NULL DEFAULT '',
    "data" TEXT NOT NULL DEFAULT '{}',
    "hasModel" INTEGER NOT NULL DEFAULT 0,
    "verts" INTEGER NOT NULL DEFAULT 0,
    "materials" INTEGER NOT NULL DEFAULT 0,
    "texMax" INTEGER NOT NULL DEFAULT 0,
    "texBytes" INTEGER NOT NULL DEFAULT 0,
    "texMaps" TEXT NOT NULL DEFAULT '',
    "animLen" REAL NOT NULL DEFAULT 0,
    "soundLen" REAL NOT NULL DEFAULT 0,
    "soundBytes" INTEGER NOT NULL DEFAULT 0,
    "fileHash" TEXT NOT NULL DEFAULT '',
    "shape" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "AssetSource" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'pack',
    "root" TEXT NOT NULL DEFAULT '',
    "repo" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "config" TEXT NOT NULL DEFAULT '{}',
    "lastScanAt" TEXT NOT NULL DEFAULT '',
    "createdAt" TEXT NOT NULL DEFAULT '',
    "updatedAt" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "AssetKind" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT '',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "match" TEXT NOT NULL DEFAULT '',
    "budget" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "RsiFinding" (
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

-- CreateTable
CREATE TABLE "Release" (
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

-- CreateTable
CREATE TABLE "CrashGroup" (
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

-- CreateTable
CREATE TABLE "WebBudget" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "max" REAL NOT NULL,
    "unit" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "WebSample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "value" REAL NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',
    "commit" TEXT NOT NULL DEFAULT '',
    "at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Playtest" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "game" TEXT NOT NULL,
    "build" TEXT NOT NULL DEFAULT '',
    "tester" TEXT NOT NULL DEFAULT '',
    "rating" INTEGER,
    "tags" TEXT NOT NULL DEFAULT '',
    "text" TEXT NOT NULL DEFAULT '',
    "at" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ContentStat" (
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

-- CreateTable
CREATE TABLE "AssetAuditHistory" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "at" TEXT NOT NULL,
    "pack" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "pass" INTEGER NOT NULL DEFAULT 0,
    "avgScore" INTEGER NOT NULL DEFAULT 0
);

-- CreateTable
CREATE TABLE "User" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "username" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "hash" TEXT NOT NULL,
    "disabledAt" DATETIME,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Role" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserRole" (
    "userId" INTEGER NOT NULL,
    "roleId" INTEGER NOT NULL,

    PRIMARY KEY ("userId", "roleId"),
    CONSTRAINT "UserRole_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserRole_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PermissionGrant" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "roleId" INTEGER,
    "userId" INTEGER,
    "perm" TEXT NOT NULL,
    "allow" BOOLEAN NOT NULL DEFAULT true,
    CONSTRAINT "PermissionGrant_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PermissionGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Folder" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "parentId" INTEGER,
    "icon" TEXT NOT NULL DEFAULT '',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Folder_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Folder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Project" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'game',
    "repoPath" TEXT NOT NULL DEFAULT '',
    "repoUrl" TEXT NOT NULL DEFAULT '',
    "folderId" INTEGER,
    "icon" TEXT NOT NULL DEFAULT '',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "settings" TEXT NOT NULL DEFAULT '{}',
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Project_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ProjectAccess" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "projectId" INTEGER,
    "folderId" INTEGER,
    "userId" INTEGER,
    "roleId" INTEGER,
    "perms" TEXT NOT NULL DEFAULT 'projects.view',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProjectAccess_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectAccess_folderId_fkey" FOREIGN KEY ("folderId") REFERENCES "Folder" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectAccess_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProjectAccess_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Node" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'station',
    "host" TEXT NOT NULL DEFAULT '',
    "port" INTEGER NOT NULL DEFAULT 4001,
    "tls" BOOLEAN NOT NULL DEFAULT false,
    "tokenHash" TEXT NOT NULL DEFAULT '',
    "secret" TEXT NOT NULL DEFAULT '',
    "specs" TEXT NOT NULL DEFAULT '{}',
    "conn" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "notes" TEXT NOT NULL DEFAULT '',
    "lastSeenAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "NodeUser" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "nodeId" INTEGER NOT NULL,
    "userId" INTEGER NOT NULL,
    "username" TEXT NOT NULL,
    CONSTRAINT "NodeUser_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "Node" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NodeUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NodeLink" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "fromId" INTEGER NOT NULL,
    "toId" INTEGER NOT NULL,
    "username" TEXT NOT NULL DEFAULT '',
    "auth" TEXT NOT NULL DEFAULT 'ssh-key',
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "checkedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "NodeLink_fromId_fkey" FOREIGN KEY ("fromId") REFERENCES "Node" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NodeLink_toId_fkey" FOREIGN KEY ("toId") REFERENCES "Node" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "DbConnection" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'clickhouse',
    "host" TEXT NOT NULL DEFAULT '',
    "port" INTEGER NOT NULL DEFAULT 0,
    "database" TEXT NOT NULL DEFAULT '',
    "username" TEXT NOT NULL DEFAULT '',
    "secretRef" TEXT NOT NULL DEFAULT '',
    "options" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BuildConfig" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "projectId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "command" TEXT NOT NULL DEFAULT '',
    "heavy" BOOLEAN NOT NULL DEFAULT false,
    "nodeKinds" TEXT NOT NULL DEFAULT '',
    "timeout" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BuildConfig_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
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

-- CreateIndex
CREATE UNIQUE INDEX "Item_key_key" ON "Item"("key");

-- CreateIndex
CREATE INDEX "Item_status_priority_idx" ON "Item"("status", "priority");

-- CreateIndex
CREATE INDEX "Item_kind_status_idx" ON "Item"("kind", "status");

-- CreateIndex
CREATE INDEX "Item_completedAt_idx" ON "Item"("completedAt");

-- CreateIndex
CREATE INDEX "Item_updatedAt_idx" ON "Item"("updatedAt");

-- CreateIndex
CREATE INDEX "Note_itemId_idx" ON "Note"("itemId");

-- CreateIndex
CREATE INDEX "Note_runId_idx" ON "Note"("runId");

-- CreateIndex
CREATE INDEX "Run_scheduleId_idx" ON "Run"("scheduleId");

-- CreateIndex
CREATE INDEX "Run_startedAt_idx" ON "Run"("startedAt");

-- CreateIndex
CREATE INDEX "Run_status_idx" ON "Run"("status");

-- CreateIndex
CREATE INDEX "Agent_name_endedAt_idx" ON "Agent"("name", "endedAt");

-- CreateIndex
CREATE INDEX "Claim_releasedAt_idx" ON "Claim"("releasedAt");

-- CreateIndex
CREATE INDEX "Claim_agentId_releasedAt_idx" ON "Claim"("agentId", "releasedAt");

-- CreateIndex
CREATE INDEX "Message_createdAt_idx" ON "Message"("createdAt");

-- CreateIndex
CREATE INDEX "Message_author_idx" ON "Message"("author");

-- CreateIndex
CREATE UNIQUE INDEX "Prompt_name_key" ON "Prompt"("name");

-- CreateIndex
CREATE INDEX "PromptVersion_promptId_idx" ON "PromptVersion"("promptId");

-- CreateIndex
CREATE INDEX "QaRun_game_kind_ranAt_idx" ON "QaRun"("game", "kind", "ranAt");

-- CreateIndex
CREATE INDEX "QaRun_ranAt_idx" ON "QaRun"("ranAt");

-- CreateIndex
CREATE INDEX "Annotation_itemKey_target_idx" ON "Annotation"("itemKey", "target");

-- CreateIndex
CREATE UNIQUE INDEX "PerfGame_slug_key" ON "PerfGame"("slug");

-- CreateIndex
CREATE INDEX "PerfRun_game_ranAt_idx" ON "PerfRun"("game", "ranAt");

-- CreateIndex
CREATE INDEX "PerfRun_game_platform_role_map_ranAt_idx" ON "PerfRun"("game", "platform", "role", "map", "ranAt");

-- CreateIndex
CREATE INDEX "PerfRun_commit_idx" ON "PerfRun"("commit");

-- CreateIndex
CREATE INDEX "PerfMetric_runId_idx" ON "PerfMetric"("runId");

-- CreateIndex
CREATE INDEX "PerfMetric_name_runId_idx" ON "PerfMetric"("name", "runId");

-- CreateIndex
CREATE INDEX "PerfFunc_runId_idx" ON "PerfFunc"("runId");

-- CreateIndex
CREATE INDEX "PerfFunc_name_idx" ON "PerfFunc"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PerfFinding_game_metric_key" ON "PerfFinding"("game", "metric");

-- CreateIndex
CREATE UNIQUE INDEX "PerfToken_name_key" ON "PerfToken"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PerfToken_hash_key" ON "PerfToken"("hash");

-- CreateIndex
CREATE INDEX "PerfShot_runId_idx" ON "PerfShot"("runId");

-- CreateIndex
CREATE INDEX "AssetWeapon_game_idx" ON "AssetWeapon"("game");

-- CreateIndex
CREATE INDEX "AssetWeapon_kind_idx" ON "AssetWeapon"("kind");

-- CreateIndex
CREATE INDEX "AssetWeapon_pack_idx" ON "AssetWeapon"("pack");

-- CreateIndex
CREATE INDEX "AssetWeapon_score_idx" ON "AssetWeapon"("score");

-- CreateIndex
CREATE INDEX "AssetWeapon_tris_idx" ON "AssetWeapon"("tris");

-- CreateIndex
CREATE INDEX "AssetWeapon_kind_pack_idx" ON "AssetWeapon"("kind", "pack");

-- CreateIndex
CREATE UNIQUE INDEX "AssetWeapon_pack_weaponId_key" ON "AssetWeapon"("pack", "weaponId");

-- CreateIndex
CREATE UNIQUE INDEX "AssetSource_name_key" ON "AssetSource"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AssetKind_key_key" ON "AssetKind"("key");

-- CreateIndex
CREATE INDEX "RsiFinding_domain_status_idx" ON "RsiFinding"("domain", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RsiFinding_subject_code_tier_key" ON "RsiFinding"("subject", "code", "tier");

-- CreateIndex
CREATE INDEX "Release_at_idx" ON "Release"("at");

-- CreateIndex
CREATE UNIQUE INDEX "Release_repo_version_channel_key" ON "Release"("repo", "version", "channel");

-- CreateIndex
CREATE INDEX "CrashGroup_at_idx" ON "CrashGroup"("at");

-- CreateIndex
CREATE UNIQUE INDEX "CrashGroup_key" ON "CrashGroup"("game", "signature", "version", "platform");

-- CreateIndex
CREATE UNIQUE INDEX "WebBudget_key" ON "WebBudget"("game", "metric");

-- CreateIndex
CREATE INDEX "WebSample_game_metric_at" ON "WebSample"("game", "metric", "at");

-- CreateIndex
CREATE INDEX "WebSample_at_idx" ON "WebSample"("at");

-- CreateIndex
CREATE INDEX "Playtest_at_idx" ON "Playtest"("at");

-- CreateIndex
CREATE UNIQUE INDEX "ContentStat_key" ON "ContentStat"("game", "category", "name", "metric");

-- CreateIndex
CREATE INDEX "AssetAuditHistory_pack_at_idx" ON "AssetAuditHistory"("pack", "at");

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Role_name_key" ON "Role"("name");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionGrant_roleId_perm_key" ON "PermissionGrant"("roleId", "perm");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionGrant_userId_perm_key" ON "PermissionGrant"("userId", "perm");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Folder_parentId_idx" ON "Folder"("parentId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE INDEX "Project_folderId_idx" ON "Project"("folderId");

-- CreateIndex
CREATE INDEX "Project_type_idx" ON "Project"("type");

-- CreateIndex
CREATE INDEX "ProjectAccess_projectId_idx" ON "ProjectAccess"("projectId");

-- CreateIndex
CREATE INDEX "ProjectAccess_folderId_idx" ON "ProjectAccess"("folderId");

-- CreateIndex
CREATE UNIQUE INDEX "Node_name_key" ON "Node"("name");

-- CreateIndex
CREATE UNIQUE INDEX "NodeUser_nodeId_userId_key" ON "NodeUser"("nodeId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeLink_fromId_toId_username_key" ON "NodeLink"("fromId", "toId", "username");

-- CreateIndex
CREATE UNIQUE INDEX "DbConnection_name_key" ON "DbConnection"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BuildConfig_projectId_name_key" ON "BuildConfig"("projectId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "NodeJob_jobKey_key" ON "NodeJob"("jobKey");

-- CreateIndex
CREATE INDEX "NodeJob_status_idx" ON "NodeJob"("status");

-- CreateIndex
CREATE INDEX "NodeJob_nodeId_idx" ON "NodeJob"("nodeId");

