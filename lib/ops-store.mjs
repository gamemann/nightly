// Tables of the ops pages (Automation, Usage's GitHub tab, offloads). Like the usage_* tables they live outside schema.prisma: the CLI
// creates and writes them (node:sqlite), the panel only reads them through Prisma raw SQL and writes by shelling out to `bin/nightly`.
export function ensure(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS gh_call (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, caller TEXT NOT NULL DEFAULT '', bucket TEXT NOT NULL DEFAULT 'core', cmd TEXT NOT NULL DEFAULT '',
  status INTEGER NOT NULL DEFAULT 0, ms INTEGER NOT NULL DEFAULT 0, limited INTEGER NOT NULL DEFAULT 0, skipped INTEGER NOT NULL DEFAULT 0, waited_ms INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS gh_call_ts ON gh_call (ts);
CREATE TABLE IF NOT EXISTS gh_rate (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, bucket TEXT NOT NULL, "limit" INTEGER NOT NULL, remaining INTEGER NOT NULL, reset INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS gh_rate_ts ON gh_rate (ts);
CREATE TABLE IF NOT EXISTS ci_run (source TEXT NOT NULL, repo TEXT NOT NULL, run_id TEXT NOT NULL, workflow TEXT NOT NULL DEFAULT '', branch TEXT NOT NULL DEFAULT '', sha TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT '', conclusion TEXT NOT NULL DEFAULT '', event TEXT NOT NULL DEFAULT '', title TEXT NOT NULL DEFAULT '', url TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (source, repo, run_id));
CREATE INDEX IF NOT EXISTS ci_run_repo ON ci_run (repo, created_at);
CREATE TABLE IF NOT EXISTS ci_repo (repo TEXT PRIMARY KEY, source TEXT NOT NULL DEFAULT '', fetched_at INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '', runs INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS check_script (name TEXT PRIMARY KEY, script TEXT NOT NULL, args TEXT NOT NULL DEFAULT '', interval_min INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
  item_key TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS check_run (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, script TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL, finished_at INTEGER,
  exit_code INTEGER, status TEXT NOT NULL DEFAULT 'running', trigger TEXT NOT NULL DEFAULT 'manual', output TEXT NOT NULL DEFAULT '', flags INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS check_run_name ON check_run (name, started_at);
CREATE TABLE IF NOT EXISTS offload_job (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, project TEXT NOT NULL DEFAULT '', target TEXT NOT NULL DEFAULT '', node TEXT NOT NULL DEFAULT 'local',
  params TEXT NOT NULL DEFAULT '{}', status TEXT NOT NULL DEFAULT 'queued', requested_by TEXT NOT NULL DEFAULT '', started_at INTEGER, finished_at INTEGER, created_at INTEGER NOT NULL,
  result TEXT NOT NULL DEFAULT '{}', log TEXT NOT NULL DEFAULT '', pid INTEGER);
CREATE INDEX IF NOT EXISTS offload_job_kind ON offload_job (kind, created_at);
`)
}
