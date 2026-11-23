# Moving a host install to Docker

Today the live panel runs on the host (`next start` on :3010 via `scripts/restart-panel.sh`, behind nginx `http://x-nightly`) and uses the host's systemd ClickHouse on :8123. That stays as it is until an operator decides to switch. Nothing here is automatic and nothing deletes the host data.

| Piece | Host install | Docker install |
|---|---|---|
| Panel | `next start`, :3010 | `panel` service, volume `panel-data` at `/data` |
| SQLite | `data/nightly.db` | `/data/nightly.db` |
| ClickHouse | systemd `clickhouse-server`, `/var/lib/clickhouse` | `clickhouse` service, volume `clickhouse-data` |
| Config | `.env` | the same `.env` (compose reads it) |

## Steps
Rehearse first with a second stack: `COMPOSE_PROJECT_NAME=nightly-try`, other container names and ports (panel 3015, ClickHouse 8124), then `docker compose down -v` on that project only.

| # | Do | Check |
|---|---|---|
| 1 | Back up: `sqlite3 data/nightly.db ".backup /safe/place/nightly.db"`; note `SELECT table, sum(rows) FROM system.parts WHERE database='nightly_usage' AND active GROUP BY table` | file exists, `PRAGMA quick_check` is ok |
| 2 | Free the ports: the host ClickHouse owns :8123 and the panel :3010. Either stop them for the cutover, or publish the stack on other ports (`NIGHTLY_PORT`, `NIGHTLY_CLICKHOUSE_PORT`) and move nginx later | `ss -ltn` shows the ports free |
| 3 | Stop the host panel: `scripts/restart-panel.sh --stop` | nothing on :3010 |
| 4 | Create the volume content: `docker compose up -d clickhouse`, then `docker compose run --rm --no-deps -v /safe/place:/seed:ro --entrypoint cp panel /seed/nightly.db /data/nightly.db` | volume has the file |
| 5 | `docker compose up -d --build` | `docker compose ps` shows both `healthy`; the log says `0 tables created` and ClickHouse statements applied |
| 6 | Refill ClickHouse from SQLite: `nightly usage ingest --resync` against the new URL (the Usage rows are kept in SQLite, so no ClickHouse dump is needed) | `usage_event`, `usage_message`, `usage_tool` counts match step 1 |
| 7 | Point nginx `x-nightly` at the panel port if it changed; register nodes again only if their address changed | login works, Usage tab loads |

Rollback: `docker compose down` (keeps volumes), start the host panel again; the host SQLite file and host ClickHouse were never modified.

## Notes
- If the Docker host caps container memory with a `cgroup-parent` slice, set `NIGHTLY_CGROUP_PARENT=system.slice` first (see the README Docker section); a throttled slice leaves containers `unhealthy` and unreachable.
- The panel container carries only `git` and `ssh`; jobs and agents run on nodes, so install `install/install-node.sh --planet` on the machine that holds the repos and point the panel at it.
- Keep the container's `NIGHTLY_CLICKHOUSE_PASSWORD` equal to the one the CLI on the host uses.
