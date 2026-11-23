Transcripts: Claude Code conversations in the panel, at /transcripts.

Design
- Index, not copy. `lib/transcripts-store.mjs` scans every readable `~/.claude/projects/**/*.jsonl` (subagent files included) into the Transcript and TranscriptMessage tables: ids, counts, tokens, tools, byte offsets. Message text stays in the file and is read lazily by byte range (`lib/transcripts-files.mjs` `readRange`), rendered by `lib/transcripts-parse.mjs` `renderLine`. Ingest is incremental (tail from the last byte offset) and runs on the scheduler tick and on demand (`nightly transcript refresh`).
- Safe paths: ids are matched against `ID_RE`, files must resolve under the configured roots (`transcriptDirs`, default every `/home/*/.claude/projects`).
- The panel never opens SQLite itself. Reads use Prisma raw SQL; writes, ingest and runs go through `bin/nightly transcript ...`.
- Runs: `lib/transcripts-run.mjs` starts a detached worker (`transcript exec <runId>`) that runs `claude -p --input-format stream-json --output-format stream-json` as the mapped OS user via `sudo -u`. Commands go in `data/transcripts/run-N/cmd.ndjson`, output comes back in `out.ndjson`, so a run survives a panel restart. A resume within 90 s of the session file's last write forks the session, so an open VS Code window on it is not disturbed.
- Live view: `/api/transcripts/stream?id=N` (SSE) stat-polls the session file and tails the live run's output for partial text.

Settings: `transcriptDirs`, `transcriptsIdleMinutes`, `transcriptsDefaultUser` (OS user claude runs as until the account system maps users to nodes).

CLI: `nightly transcript list|show|start|send|stop|refresh`.

Extension points: `src/server/transcriptsAccess.ts` is the only seam to the account system (replace `getViewer`). Permissions used: transcripts.view, transcripts.viewAll, transcripts.run, nodes.use, agents.view.

Known limits: in print mode a tool needing approval under the default permission mode is denied (live approval needs `--permission-prompt-tool stdio`); subagent files created after the last full ingest are found on the next full ingest.
