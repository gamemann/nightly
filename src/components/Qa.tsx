"use client"
import { useState } from "react"
import { api, type RouterOutputs } from "~/trpc/react"
import { ago } from "./pills"

type Run = RouterOutputs["qa"]["list"][number]
const TREND = 30
const imgUrl = (r: Run, f: string) => `/attachments/qa-${r.id}/${encodeURIComponent(f)}`
const badge = (ok: boolean) => (ok ? "bg-emerald-400/15 text-emerald-300" : "bg-red-400/15 text-red-300")

export function Qa() {
    const list = api.qa.list.useQuery(undefined, { refetchInterval: 30_000 })
    const rows = list.data ?? []
    const keys = [...new Set(rows.map((r) => `${r.game}\u0000${r.kind}`))].sort()
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">QA</h1>
            <p className="mt-0.5 mb-4 text-[12px] text-muted">Fuzz sweeps, visual checks and suites pushed from the game machine, newest run per game and kind with the last {TREND} as a trend.</p>
            {list.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
            {list.data && keys.length === 0 && <div className="mb-6 rounded-lg border border-line px-3 py-6 text-center text-muted">No QA runs yet. Post one (see below).</div>}
            <div className="space-y-4">
                {keys.map((k) => {
                    const [game, kind] = k.split("\u0000")
                    return <Card key={k} game={game} kind={kind} runs={rows.filter((r) => r.game === game && r.kind === kind).slice(0, TREND)} />
                })}
            </div>
            <Docs />
        </div>
    )
}

function Card({ game, kind, runs }: { game: string; kind: string; runs: Run[] }) {
    const [open, setOpen] = useState<string | null>(null)
    const [sel, setSel] = useState(runs[0].id)
    const run = runs.find((r) => r.id === sel) ?? runs[0]
    const rate = Math.round((runs.filter((r) => r.ok).length / runs.length) * 100)
    return (
        <section className="rounded-lg border border-line bg-panel/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] font-medium">{game}</span>
                <span className="rounded bg-hover px-1.5 text-[11px] text-dim">{kind}</span>
                <span className={`rounded px-1.5 text-[11px] ${badge(runs[0].ok)}`}>{runs[0].ok ? "pass" : "FAIL"}</span>
                <span className="text-[12px] tabular-nums text-muted">{runs[0].total - runs[0].failedCount}/{runs[0].total} ok · {ago(runs[0].ranAt)}{runs[0].commit && <> · <span className="font-mono">{runs[0].commit.slice(0, 9)}</span></>}</span>
                <span className="ml-auto text-[12px] tabular-nums text-muted">pass rate {rate}% over {runs.length} run{runs.length === 1 ? "" : "s"}</span>
            </div>
            <div className="mt-3 flex h-6 items-end gap-0.5" title="oldest to newest; click a bar to inspect that run">
                {[...runs].reverse().map((r) => {
                    const pct = r.total ? (r.total - r.failedCount) / r.total : r.ok ? 1 : 0
                    return (
                        <button key={r.id} onClick={() => setSel(r.id)} title={`${new Date(r.ranAt).toLocaleString("en-GB")}: ${r.total - r.failedCount}/${r.total} ok`}
                            style={{ height: `${Math.max(20, pct * 100)}%` }}
                            className={`w-2 rounded-sm ${r.ok ? "bg-emerald-400/70" : "bg-red-400/80"} ${r.id === run.id ? "outline outline-1 outline-fg" : ""}`} />
                    )
                })}
            </div>
            {run.id !== runs[0].id && <p className="mt-2 text-[12px] text-dim">Showing run from {new Date(run.ranAt).toLocaleString("en-GB")} ({run.total - run.failedCount}/{run.total} ok).</p>}
            {run.failures.length > 0 && (
                <ul className="mt-3 space-y-2">
                    {run.failures.map((f, i) => (
                        <li key={i} className="rounded-md border border-line px-3 py-2 text-[12px]">
                            <div className="font-mono text-red-300">{f.name}</div>
                            {f.reasons.map((r, j) => <div key={j} className="text-dim">{r}</div>)}
                            {f.note && <div className="text-muted">{f.note}</div>}
                            {f.repro && (
                                <div className="mt-1 flex items-center gap-2">
                                    <code className="min-w-0 flex-1 truncate rounded bg-hover px-1.5 py-0.5 font-mono text-[11px]">{f.repro}</code>
                                    <button onClick={() => { void navigator.clipboard?.writeText(f.repro); setOpen(`${run.id}-${i}`) }} className="shrink-0 rounded border border-line px-2 py-0.5 text-[11px] hover:bg-hover">
                                        {open === `${run.id}-${i}` ? "copied" : "copy"}
                                    </button>
                                </div>
                            )}
                        </li>
                    ))}
                </ul>
            )}
            {run.images.length > 0 && (
                <div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
                    {run.images.map((im) => (
                        <figure key={im.file} className="space-y-1">
                            <a href={imgUrl(run, im.file)} target="_blank" rel="noreferrer">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={imgUrl(run, im.file)} alt={im.file} loading="lazy" className="h-28 w-full rounded-md border border-line object-cover" />
                            </a>
                            <figcaption className="truncate text-[11px] text-muted" title={im.note || im.file}>{im.note || im.file}</figcaption>
                        </figure>
                    ))}
                </div>
            )}
        </section>
    )
}

function Docs() {
    return (
        <section className="mt-8 border-t border-line pt-4 text-[12px] text-dim">
            <span className="label">Posting results</span>
            <p className="mt-2">From the game machine (needs only curl and python3; set <code className="font-mono">QA_URL</code>, default <code className="font-mono">http://x-tmc-dev01:3010</code>; if the panel login is on, also <code className="font-mono">QA_USER</code> and <code className="font-mono">QA_PASSWORD</code>):</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-hover p-3 font-mono text-[11px] leading-relaxed">{`scripts/qa-post.sh fuzz game-arena .godot/fuzz/first/summary.json
scripts/qa-post.sh visual game-arena visual.log .godot/test-logs/visual
scripts/qa-post.sh suite game-arena result.json     # a payload in the format below`}</pre>
            <p className="mt-2">Ingest is <code className="font-mono">POST /api/qa</code> with JSON, which anything can call directly:</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-hover p-3 font-mono text-[11px] leading-relaxed">{`{ "kind": "fuzz|visual|suite", "game": "game-arena", "commit": "abc1234", "timestamp": "ISO-8601 (default now)",
  "summary": { "total": 9, "failed": 0 },          // fuzz summary.json (pairs, failed) and visual (maps, ok) also accepted
  "failures": [ { "name": "dm_pit seed 2", "repro": "tools/fuzz.sh --repro dm_pit 2", "reasons": ["..."] } ],
  "attachments": [ { "name": "dm_box_eye_diff.png", "data": "<base64>", "note": "dm_box" } ] }   // png/jpg, 6 MB each, 40 max`}</pre>
            <p className="mt-2">Visual producer: <code className="font-mono">tools/visual_check.sh</code> prints <code className="font-mono">visual: N/M maps ok</code> and leaves <code className="font-mono">*_diff.png</code> in <code className="font-mono">.godot/test-logs/visual/</code>; it does not yet write JSON, so the poster reads that log line and attaches the diffs. The newest 200 runs per game and kind are kept.</p>
        </section>
    )
}
