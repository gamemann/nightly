"use client"
import { useState } from "react"
import { api, type RouterOutputs } from "~/trpc/react"
import { ago } from "./pills"
import { parsePage } from "~/lib/paging"
import { DataTable, ListControls, type Column } from "./DataTable"
import { Pagination, useUrlParams } from "./Pagination"
import { HeatGrid, Legend, Panel, StackedBars } from "./Charts"
import { COLOR, qaAreaGrid, qaTrend } from "../../lib/charts.mjs"

type Run = RouterOutputs["qa"]["cards"]["page"]["rows"][number]["runs"][number]
type Slim = RouterOutputs["qa"]["overview"][number]
const TREND = 30
const CARD_SPEC = { sorts: ["game", "kind", "ranAt"], sort: "game", dir: "asc", filters: ["game", "kind", "result"] } as const
const CARD_SORTS = [{ key: "game", label: "game" }, { key: "kind", label: "kind" }, { key: "ranAt", label: "latest run" }]
const imgUrl = (r: Run, f: string) => `/attachments/qa-${r.id}/${encodeURIComponent(f)}`
const badge = (ok: boolean) => (ok ? "bg-emerald-400/15 text-emerald-300" : "bg-red-400/15 text-red-300")

export function Qa() {
    const { sp } = useUrlParams("c")
    const q = parsePage(sp, CARD_SPEC, "c")
    const cards = api.qa.cards.useQuery({ page: q.page, size: q.size, sort: q.sort, dir: q.dir, q: q.q || undefined, f: q.f, runs: TREND }, { refetchInterval: 30_000, placeholderData: (p) => p })
    const overview = api.qa.overview.useQuery({ days: DAYS }, { refetchInterval: 30_000 })
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">QA</h1>
            <p className="mt-0.5 mb-4 text-[12px] text-muted">Fuzz sweeps, visual checks, suites and the nightly frame-time budget pushed from the game machine, newest run per game and kind with the last {TREND} as a trend.</p>
            {cards.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
            {cards.data && cards.data.page.total === 0 && !q.q && Object.keys(q.f).length === 0 && <div className="mb-6 rounded-lg border border-line px-3 py-6 text-center text-muted">No QA runs yet. Post one (see below).</div>}
            {overview.data && overview.data.length > 0 && <QaOverview rows={overview.data} />}
            {cards.data && (cards.data.page.total > 0 || q.q || Object.keys(q.f).length > 0) && (
                <ListControls ns="c" q={q.q} active={q.f} sort={q.sort} dir={q.dir} sorts={CARD_SORTS} searchHint="Search game or kind"
                    filters={[{ key: "game", label: "Game", options: cards.data.facets.game.map((value) => ({ value })) }, { key: "kind", label: "Kind", options: cards.data.facets.kind.map((value) => ({ value })) },
                        { key: "result", label: "Latest", options: [{ value: "pass" }, { value: "fail" }] }]} />
            )}
            {cards.data && cards.data.page.total === 0 && (q.q || Object.keys(q.f).length > 0) && <div className="mb-4 rounded-lg border border-line px-3 py-6 text-center text-muted">No card matches.</div>}
            <div className="space-y-4">
                {cards.data?.page.rows.map((c) => c.kind === "perf" ? <PerfCard key={`${c.game}\u0000${c.kind}`} game={c.game} runs={c.runs} /> : <Card key={`${c.game}\u0000${c.kind}`} game={c.game} kind={c.kind} runs={c.runs} />)}
            </div>
            {cards.data && cards.data.page.total > 0 && <Pagination p={cards.data.page} ns="c" />}
            <QaHistory />
            <Docs />
        </div>
    )
}

const QA_SPEC = { sorts: ["ranAt", "game", "kind", "ok", "failed", "total", "commit"], sort: "ranAt", dir: "desc", filters: ["game", "kind", "result"] } as const

/** Every QA run, paged, sortable, filterable and searchable on the server. */
function QaHistory() {
    const { sp } = useUrlParams()
    const q = parsePage(sp, QA_SPEC)
    const h = api.qa.history.useQuery({ page: q.page, size: q.size, sort: q.sort as "ranAt", dir: q.dir, q: q.q || undefined, game: q.f.game, kind: q.f.kind, result: (q.f.result as "pass" | "fail") || undefined }, { placeholderData: (p) => p })
    if (!h.data) return null
    const cols: Column<(typeof h.data.page.rows)[number]>[] = [
        { key: "ranAt", label: "Ran", sortable: true, className: "whitespace-nowrap text-dim", render: (r) => new Date(r.ranAt).toLocaleString("en-GB") },
        { key: "game", label: "Game", sortable: true, render: (r) => r.game },
        { key: "kind", label: "Kind", sortable: true, render: (r) => r.kind },
        { key: "ok", label: "Result", sortable: true, render: (r) => <span className={`rounded px-1.5 text-[11px] ${badge(r.ok)}`}>{r.ok ? "pass" : "FAIL"}</span> },
        { key: "failed", label: "Failed", sortable: true, className: "tabular-nums", render: (r) => r.failedCount },
        { key: "total", label: "Total", sortable: true, className: "tabular-nums", render: (r) => r.total },
        { key: "commit", label: "Commit", sortable: true, className: "font-mono text-muted", render: (r) => r.commit.slice(0, 9) },
    ]
    const opts = (xs: string[]) => xs.map((value) => ({ value }))
    return (
        <section className="mt-6">
            <h2 className="mb-2 text-[13px] font-semibold">All runs</h2>
            <DataTable cols={cols} data={h.data.page} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search game, kind, commit, failures"
                filters={[{ key: "game", label: "Game", options: opts(h.data.games) }, { key: "kind", label: "Kind", options: opts(h.data.kinds) }, { key: "result", label: "Result", options: [{ value: "pass" }, { value: "fail" }] }]} />
        </section>
    )
}

const DAYS = 30
const cardId = (game: string, kind: string) => `qa-${game}-${kind}`.replace(/[^\w-]/g, "_")
const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })

/** Pass/fail over time across everything, and one heatmap row per game and kind. Click-through scrolls to that card. */
function QaOverview({ rows }: { rows: Slim[] }) {
    const trend = qaTrend(rows, { days: DAYS })
    const grid = qaAreaGrid(rows, { days: 14 })
    const pass = trend.reduce((n, d) => n + d.pass, 0)
    const fail = trend.reduce((n, d) => n + d.fail, 0)
    const byId = new Map(rows.map((r) => [r.id, r]))
    return (
        <div className="mb-4 grid gap-3 lg:grid-cols-2">
            <Panel title="Pass and fail by day" subtitle={`QA runs per day (UTC) across all games, last ${DAYS} days. Click a day to jump to the newest run's card.`} empty={pass + fail === 0 && `No QA run in the last ${DAYS} days.`}
                legend={<Legend items={[{ label: "pass", color: COLOR.good, count: pass }, { label: "fail", color: COLOR.bad, count: fail }]} />}>
                <StackedBars ariaLabel="QA runs per day, pass and fail" unit="runs"
                    bars={trend.map((d) => ({ key: d.key, label: d.key.slice(5), id: d.ids[0], segments: [{ key: "pass", label: "pass", value: d.pass, color: COLOR.good }, { key: "fail", label: "fail", value: d.fail, color: COLOR.bad }] }))}
                    onBar={(b) => { const r = byId.get(Number(b.id)); if (r) jump(cardId(r.game, r.kind)) }} />
            </Panel>
            <Panel title="Health by area" subtitle="Share of runs passing per game and kind and day, last 14 days (UTC). Outlined cell: nothing ran. Click to jump to the card."
                legend={<Legend items={[{ label: "all passed", color: COLOR.good }, { label: "half or more passed", color: COLOR.warn }, { label: "mostly failed", color: COLOR.bad }]} />}>
                <HeatGrid ratio ariaLabel="QA pass share per area and day" cols={grid.cols} labelWidth={150} onCell={(row) => { const r = grid.rows.find((x) => x.key === row); if (r) jump(cardId(r.game, r.kind)) }}
                    rows={grid.rows.map((r) => ({ key: r.key, label: `${r.game} ${r.kind}`, cells: r.cells.map((c) => ({ key: c.key, value: c.rate, id: c.total ? c.key : undefined, tip: `${r.game} ${r.kind}, ${c.key}: ${c.total ? `${c.pass} of ${c.total} passed` : "no run"}` })) }))} />
            </Panel>
        </div>
    )
}

function Card({ game, kind, runs }: { game: string; kind: string; runs: Run[] }) {
    const [open, setOpen] = useState<string | null>(null)
    const [sel, setSel] = useState(runs[0].id)
    const run = runs.find((r) => r.id === sel) ?? runs[0]
    const rate = Math.round((runs.filter((r) => r.ok).length / runs.length) * 100)
    return (
        <section id={cardId(game, kind)} className="scroll-mt-4 rounded-lg border border-line bg-panel/40 p-4">
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
                            {/\.(mp4|webm)$/i.test(im.file) ? (
                                <video src={imgUrl(run, im.file)} controls loop muted playsInline preload="metadata" className="h-28 w-full rounded-md border border-line object-cover" />
                            ) : (
                                <a href={imgUrl(run, im.file)} target="_blank" rel="noreferrer">
                                    {/* eslint-disable-next-line @next/next/no-img-element */}
                                    <img src={imgUrl(run, im.file)} alt={im.file} loading="lazy" className="h-28 w-full rounded-md border border-line object-cover" />
                                </a>
                            )}
                            <figcaption className="truncate text-[11px] text-muted" title={im.note || im.file}>{im.note || im.file}</figcaption>
                        </figure>
                    ))}
                </div>
            )}
        </section>
    )
}

const UNIT: Record<string, string> = { p50_ms: "ms", p95_ms: "ms", p99_ms: "ms", stall_ms: "ms", load_s: "s", rss_mb: "MB", pack_mb: "MB" }

type Pt = { v: number; base?: number; budget: number; bad: boolean; at: string }

/** One metric over the last runs, oldest to newest: value line, baseline and budget as dashed lines, failing runs in red. */
function Trend({ metric, points }: { metric: string; points: Pt[] }) {
    const W = 220, H = 70, P = 4
    const all = points.flatMap((p) => [p.v, p.base ?? p.v, Math.min(p.budget, Math.max(p.v, (p.base ?? p.v) * 1.5))])
    const lo = Math.min(...all) * 0.9, hi = Math.max(...all) * 1.05 || 1
    const x = (i: number) => P + (points.length < 2 ? (W - 2 * P) / 2 : (i * (W - 2 * P)) / (points.length - 1))
    const y = (v: number) => H - P - ((v - lo) / (hi - lo || 1)) * (H - 2 * P)
    const line = (f: (p: Pt) => number | undefined) =>
        points.flatMap((p, i) => { const v = f(p); return v === undefined ? [] : [`${x(i).toFixed(1)},${y(v).toFixed(1)}`] }).join(" ")
    const last = points[points.length - 1]
    return (
        <figure className="rounded-md border border-line px-2 py-1.5">
            <figcaption className="flex items-baseline justify-between text-[11px]">
                <span className="font-mono text-dim">{metric}</span>
                <span className={`tabular-nums ${last.bad ? "text-red-300" : "text-muted"}`}>{last.v.toFixed(1)} {UNIT[metric]}{last.base !== undefined && <> · base {last.base.toFixed(1)}</>}</span>
            </figcaption>
            <svg viewBox={`0 0 ${W} ${H}`} className="mt-1 h-[70px] w-full" role="img" aria-label={`${metric} trend`}>
                <polyline points={line((p) => p.budget)} fill="none" stroke="#f5b84a" strokeWidth="1" strokeDasharray="3 3" opacity="0.7" />
                <polyline points={line((p) => p.base)} fill="none" stroke="#6c717c" strokeWidth="1" strokeDasharray="2 3" />
                <polyline points={line((p) => p.v)} fill="none" stroke="#8b8cf8" strokeWidth="1.5" />
                {points.map((p, i) => (
                    <circle key={i} cx={x(i)} cy={y(p.v)} r={p.bad ? 3 : 1.8} fill={p.bad ? "#f87171" : "#8b8cf8"}><title>{`${new Date(p.at).toLocaleString("en-GB")}: ${p.v.toFixed(2)} ${UNIT[metric]}${p.bad ? " (over budget)" : ""}`}</title></circle>
                ))}
            </svg>
        </figure>
    )
}

/** Frame-time, memory and load budget per map (kind perf): a chart per metric, last runs, baseline and budget drawn. */
function PerfCard({ game, runs }: { game: string; runs: Run[] }) {
    const newest = runs[0]
    const sum = newest.summary
    const chrono = [...runs].reverse().filter((r) => r.summary?.metrics)
    const maps = Object.keys(sum?.metrics ?? {})
    return (
        <section className="rounded-lg border border-line bg-panel/40 p-4">
            <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[13px] font-medium">{game}</span>
                <span className="rounded bg-hover px-1.5 text-[11px] text-dim">perf</span>
                <span className={`rounded px-1.5 text-[11px] ${badge(newest.ok)}`}>{newest.ok ? "within budget" : "OVER BUDGET"}</span>
                <span className="text-[12px] tabular-nums text-muted">{newest.failedCount} of {newest.total} metrics over · {ago(newest.ranAt)}{newest.commit && <> · <span className="font-mono">{newest.commit.slice(0, 9)}</span></>}{sum?.dirty && " · dirty tree"}</span>
                <span className="ml-auto text-[12px] text-muted">{sum?.gpu} · {sum?.resolution} · tolerance {Math.round((sum?.tolerance ?? 0) * 100)}%</span>
            </div>
            {newest.failures.length > 0 && (
                <ul className="mt-3 space-y-1">
                    {newest.failures.map((f, i) => <li key={i} className="font-mono text-[12px] text-red-300">{f.name} <span className="text-dim">{f.reasons.join("; ")}</span></li>)}
                </ul>
            )}
            {maps.map((m) => (
                <div key={m} className="mt-4">
                    <div className="mb-1.5 font-mono text-[12px] text-dim">{m}</div>
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-2">
                        {Object.keys(sum?.metrics?.[m] ?? {}).map((k) => {
                            const points: Pt[] = chrono.filter((r) => r.summary?.metrics?.[m]?.[k]).map((r) => {
                                const x = r.summary!.metrics![m][k]
                                return { v: x.value, base: x.baseline, budget: x.budget, bad: x.status === "fail", at: String(r.ranAt) }
                            })
                            return <Trend key={k} metric={k} points={points} />
                        })}
                    </div>
                </div>
            ))}
            <p className="mt-3 text-[11px] text-muted">Purple: median of the night&apos;s runs. Grey dashed: baseline (tests/perf_budget.json). Amber dashed: budget (baseline plus tolerance, or the cap). Red: over budget. Last {TREND} runs, oldest left.</p>
        </section>
    )
}

function Docs() {
    return (
        <section className="mt-8 border-t border-line pt-4 text-[12px] text-dim">
            <span className="label">Posting results</span>
            <p className="mt-2">From the game machine (needs only curl and python3; set <code className="font-mono">QA_URL</code>, default <code className="font-mono">$NIGHTLY_PUBLIC_URL</code>, else <code className="font-mono">http://localhost:3010</code>, so set it to this panel&apos;s address from another machine; if the panel login is on, also <code className="font-mono">QA_USER</code> and <code className="font-mono">QA_PASSWORD</code>):</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-hover p-3 font-mono text-[11px] leading-relaxed">{`scripts/qa-post.sh fuzz my-game .godot/fuzz/first/summary.json
scripts/qa-post.sh visual my-game visual.log .godot/test-logs/visual
scripts/qa-post.sh suite my-game result.json     # a payload in the format below
scripts/qa-post.sh perf my-game result.json      # tools/perf_budget.sh --post builds it; summary.metrics drives the trend charts`}</pre>
            <p className="mt-2">Ingest is <code className="font-mono">POST /api/qa</code> with JSON, which anything can call directly:</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-hover p-3 font-mono text-[11px] leading-relaxed">{`{ "kind": "fuzz|visual|suite|perf", "game": "my-game", "commit": "abc1234", "timestamp": "ISO-8601 (default now)",
  "summary": { "total": 9, "failed": 0 },          // fuzz summary.json (pairs, failed) and visual (maps, ok) also accepted
  "failures": [ { "name": "dm_pit seed 2", "repro": "tools/fuzz.sh --repro dm_pit 2", "reasons": ["..."] } ],
  "attachments": [ { "name": "dm_box_eye_diff.png", "data": "<base64>", "note": "dm_box" } ] }   // png/jpg, 6 MB each, 40 max`}</pre>
            <p className="mt-2">Visual producer: <code className="font-mono">tools/visual_check.sh</code> prints <code className="font-mono">visual: N/M maps ok</code> and leaves <code className="font-mono">*_diff.png</code> in <code className="font-mono">.godot/test-logs/visual/</code>; it does not yet write JSON, so the poster reads that log line and attaches the diffs. The newest 200 runs per game and kind are kept.</p>
        </section>
    )
}
