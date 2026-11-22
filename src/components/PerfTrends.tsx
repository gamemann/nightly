"use client"
// Performance > trends: status cards, worst offenders, combined frame-time chart, sectioned metric charts, heatmap,
// distribution and compare-two-runs. All data shaping is in lib/perf-chart.mjs; this file is layout and wiring.
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { api } from "~/trpc/react"
import { unitOf } from "../../lib/perf.mjs"
import { FRAME_PERCENTILES, PALETTE, SECTIONS, budgetsFor, colorOf, dateFull, diffRuns, fmt, fmtPct, heatmap, histogram, infoOf, limitOf, lowData, pointDeltas, regressionReasons, sectionOf, seriesOf, statusCards, summarise, worstMetrics, type RunRow, type Summary } from "../../lib/perf-chart.mjs"
import { BarList, Heatmap, LineChart, Sparkline, useChartSync, type ChartSeries, type ChartSync } from "./PerfChart"

type Scope = { platform?: string; role?: string; map?: string; bots?: number }
const HEAD = ["fps", "frame_ms_p50", "frame_ms_p95", "frame_ms_p99", "tick_ms", "draw_calls", "memory_mb"]

function Badge({ s, unit }: { s: Summary; unit: string }) {
    if (s.delta === null) return <span className="rounded bg-hover px-1.5 py-0.5 text-[11px] text-muted">first run</span>
    const cls = s.good === null ? "bg-hover text-dim" : s.good ? "bg-emerald-400/15 text-emerald-300" : "bg-red-400/15 text-red-300"
    return <span title={`vs previous run: ${fmt(s.delta, unit)}`} className={`rounded px-1.5 py-0.5 text-[11px] tabular-nums ${cls}`}>{s.good === null ? "= " : s.good ? "▼▲".charAt(1) + " better " : "▼ worse "}{fmtPct(s.pct)}</span>
}
const Arrow = ({ t }: { t: Summary["trend"] }) => !t.enough ? <span className="text-muted" title="Not enough runs for a trend">-</span> : t.dir === "flat" ? <span className="text-dim" title="Flat over the last 8 runs">{"→"} flat</span> : t.dir === "better" ? <span className="text-emerald-300" title={`Improving ${fmtPct(t.pct)} over the last 8 runs`}>{"↑"} improving</span> : <span className="text-red-300" title={`Worsening ${fmtPct(t.pct)} over the last 8 runs`}>{"↓"} worsening</span>

function Card({ label, children, sub, tone }: { label: string; children: React.ReactNode; sub?: React.ReactNode; tone?: "ok" | "bad" | "warn" }) {
    const ring = tone === "bad" ? "border-red-400/40" : tone === "warn" ? "border-amber-400/40" : tone === "ok" ? "border-emerald-400/30" : "border-line"
    return <div className={`rounded-xl border ${ring} bg-panel/40 p-3 transition-colors`}><div className="text-[11px] uppercase tracking-wide text-muted">{label}</div><div className="mt-1 text-[20px] leading-tight tabular-nums">{children}</div>{sub && <div className="mt-1 text-[11px] text-dim">{sub}</div>}</div>
}

export function Trends({ game, scope, onTab }: { game: string; scope: Scope; onTab?: (t: "offenders") => void }) {
    const q = api.perf.trendAll.useQuery({ game, ...scope, limit: 200 })
    const router = useRouter()
    const sync = useChartSync()
    const [shut, setShut] = useState<Set<string>>(new Set())
    const runs = (q.data?.runs ?? []) as RunRow[]
    const budgets = q.data?.budgets ?? []
    const metrics = useMemo(() => { const s = new Set<string>(); runs.forEach((r) => Object.keys(r.metrics).forEach((m) => s.add(m))); return [...s] }, [runs])
    const cards = useMemo(() => statusCards(runs, metrics, budgets), [runs, metrics, budgets])
    const open = (id?: number | string) => { if (id !== undefined) router.push(`/perf/${game}/run/${id}`) }

    if (q.isLoading) return <div className="p-6 text-center text-muted">Loading…</div>
    if (!runs.length) return <div className="rounded-lg border border-line px-3 py-6 text-center text-muted">No runs in this scope. Ingest one: <code>nightly perf ingest report.json --game {game}</code></div>

    const order = [...HEAD.filter((m) => metrics.includes(m)), ...metrics.filter((m) => !HEAD.includes(m))]
    const grouped = [...SECTIONS.map((s) => s.id), "other"].map((id) => ({ id, title: SECTIONS.find((s) => s.id === id)?.title ?? "Other metrics", blurb: SECTIONS.find((s) => s.id === id)?.blurb ?? "Everything else the runs reported.", ms: order.filter((m) => sectionOf(m) === id && !FRAME_PERCENTILES.includes(m)) }))
    const hasFrame = FRAME_PERCENTILES.some((m) => metrics.includes(m))
    const worst = worstMetrics(cards)
    const fps = cards.fps
    const newest = runs[runs.length - 1]

    return (
        <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Card label="Budgets" tone={cards.budgets.checked === 0 ? undefined : cards.budgets.pass ? "ok" : "bad"} sub={cards.budgets.checked === 0 ? "No budget covers this scope. Set some on the budgets tab." : cards.budgets.pass ? `${cards.budgets.checked} metrics within budget` : `Over: ${cards.budgets.failing.join(", ")}`}>
                    {cards.budgets.checked === 0 ? <span className="text-muted">none</span> : cards.budgets.pass ? <span className="text-emerald-300">{"✓"} pass</span> : <span className="text-red-300">{"✗"} {cards.budgets.failing.length} failing</span>}
                </Card>
                <Card label="Latest fps" sub={fps ? <span className="flex items-center gap-2"><Badge s={fps} unit="" /><Arrow t={fps.trend} /></span> : "No fps metric recorded"}>{fps ? <span className="flex items-center gap-2">{fmt(fps.latest)}<Sparkline values={fps.spark} color={PALETTE.p50} label="fps trend" /></span> : <span className="text-muted">-</span>}</Card>
                <Card label="Worst metric" tone={cards.worst ? "warn" : "ok"} sub={cards.worst ? <span className="line-clamp-2">{cards.worst.reason}</span> : "Nothing over budget or off baseline in the newest run."}>{cards.worst ? <span className="font-mono text-[15px]">{"▲"} {cards.worst.metric}</span> : <span className="text-emerald-300">{"✓"} clean</span>}</Card>
                <Card label="Regressions" tone={cards.regressions ? "warn" : "ok"} sub={`in the last 10 runs, across ${cards.regressionRuns} run${cards.regressionRuns === 1 ? "" : "s"}`}>{cards.regressions ? <span className="text-amber-300">{"▲"} {cards.regressions}</span> : <span className="text-emerald-300">{"✓"} 0</span>}</Card>
            </div>

            {worst.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-line bg-panel/40 px-3 py-2 text-[12px]">
                    <span className="text-muted">Worst offenders</span>
                    {worst.map((w) => <a key={w.metric} href={`#m-${w.metric}`} title={w.reason} className="rounded border border-line px-2 py-0.5 font-mono transition-colors hover:bg-hover"><span className="text-amber-300">{"▲"}</span> {w.metric} <span className="text-dim">{fmt(w.value, unitOf(w.metric))}</span></a>)}
                    <button type="button" onClick={() => onTab?.("offenders")} className="ml-auto text-sky-300 hover:underline">top offenders by function {"→"}</button>
                </div>
            )}

            {hasFrame && <FrameChart runs={runs} budgets={budgets} sync={sync} onOpen={open} />}

            {grouped.filter((g) => g.ms.length).map((g) => (
                <section key={g.id} aria-labelledby={`sec-${g.id}`}>
                    <button type="button" id={`sec-${g.id}`} aria-expanded={!shut.has(g.id)} onClick={() => setShut((s) => { const n = new Set(s); if (n.has(g.id)) n.delete(g.id); else n.add(g.id); return n })} className="flex w-full items-baseline gap-2 border-b border-line pb-1 text-left">
                        <span className="text-[10px] text-muted">{shut.has(g.id) ? "▶" : "▼"}</span><span className="text-[14px]">{g.title}</span><span className="text-[11px] text-muted">{g.ms.length} metric{g.ms.length === 1 ? "" : "s"} · {g.blurb}</span>
                    </button>
                    {!shut.has(g.id) && <div className="mt-3 grid gap-3 md:grid-cols-2">{g.ms.map((m) => <MetricCard key={m} metric={m} runs={runs} budgets={budgets} sync={sync} onOpen={open} />)}</div>}
                </section>
            ))}

            <HeatmapView runs={runs} metrics={order} onOpen={open} />
            <Distribution runs={runs} metrics={order} />
            <Compare runs={runs} budgets={budgets} game={game} />
            <p className="text-[11px] text-muted">{runs.length} runs from {dateFull(new Date(runs[0].ranAt).getTime())} to {dateFull(new Date(newest.ranAt).getTime())}. Regression: worse than the median of the previous 5 runs by more than 10%.</p>
        </div>
    )
}

function MetricCard({ metric, runs, budgets, sync, onOpen }: { metric: string; runs: RunRow[]; budgets: ReturnType<typeof Array.from>; sync: ChartSync; onOpen: (id?: number | string) => void }) {
    const pts = useMemo(() => seriesOf(runs, metric), [runs, metric])
    const info = infoOf(metric), unit = unitOf(metric)
    const sum = useMemo(() => summarise(runs, metric, budgets as never[]), [runs, metric, budgets])
    const deltas = useMemo(() => pointDeltas(pts, metric, budgets as never[]), [pts, metric, budgets])
    const regs = useMemo(() => regressionReasons(pts, metric, budgets as never[]), [pts, metric, budgets])
    const low = lowData(pts)
    const series: ChartSeries[] = [{ key: metric, label: metric, color: colorOf(metric), points: pts.map((p, i) => ({ t: p.t, v: p.value, id: p.id, meta: { commit: p.commit.slice(0, 9), build: p.build, map: p.map, bots: p.bots, platform: p.platform, vs_prev: deltas[i].pct === null ? "" : fmtPct(deltas[i].pct), vs_budget: deltas[i].budget ? `${deltas[i].budget!.ok ? "within" : "over"} ${fmt(deltas[i].budget!.limit, unit)}` : "" } })) }]
    const lines = [...new Map(budgetsFor(budgets as never[], metric, {}).map((b) => [`${b.max !== undefined ? "max" : "min"}${limitOf(b)}`, { value: limitOf(b), label: `${b.max !== undefined ? "max" : "min"} ${fmt(limitOf(b), unit)}` }])).values()]
    return (
        <div id={`m-${metric}`} className="scroll-mt-4">
            <div className="mb-1 flex flex-wrap items-center gap-2 px-1 text-[12px]">
                <span className="font-mono text-[13px]">{metric}</span>
                {sum && <><span className="tabular-nums">{fmt(sum.latest, unit)}</span><Badge s={sum} unit={unit} /><Arrow t={sum.trend} /><span className="ml-auto"><Sparkline values={sum.spark} color={colorOf(metric)} label={`${metric} trend`} /></span></>}
            </div>
            <LineChart title={info.title} unit={unit} series={series} lines={lines} markers={regs.map((r) => ({ t: pts[r.index].t, v: r.value, id: r.id, reason: r.reason }))} sync={sync} onPointClick={(p) => onOpen(p.id)} height={190} />
            <p className="mt-1 px-1 text-[11px] text-dim">{info.desc} <span className="text-muted">Good: {info.good}</span></p>
            {low && <p className="mt-0.5 px-1 text-[11px] text-amber-300/90">{low}</p>}
        </div>
    )
}

function FrameChart({ runs, budgets, sync, onOpen }: { runs: RunRow[]; budgets: unknown[]; sync: ChartSync; onOpen: (id?: number | string) => void }) {
    const names = FRAME_PERCENTILES.filter((m) => runs.some((r) => typeof r.metrics[m] === "number"))
    const series: ChartSeries[] = names.map((m) => ({ key: m, label: m.replace("frame_ms_", ""), color: colorOf(m), points: seriesOf(runs, m).map((p) => ({ t: p.t, v: p.value, id: p.id, meta: { commit: p.commit.slice(0, 9), map: p.map, bots: p.bots, platform: p.platform } })) }))
    const bands = [{ from: "frame_ms_p50", to: "frame_ms_p95", color: colorOf("frame_ms_p95") }, { from: "frame_ms_p95", to: "frame_ms_p99", color: colorOf("frame_ms_p99") }].filter((b) => names.includes(b.from) && names.includes(b.to))
    const lines = [...new Map((budgets as { metric: string; max?: number; min?: number }[]).filter((b) => FRAME_PERCENTILES.includes(b.metric) && b.max !== undefined).map((b) => [`${b.metric}${b.max}`, { value: b.max!, label: `${b.metric.replace("frame_ms_", "")} budget ${b.max} ms` }])).values()]
    const markers = names.flatMap((m) => { const pts = seriesOf(runs, m); return regressionReasons(pts, m, budgets as never[]).map((r) => ({ t: pts[r.index].t, v: r.value, id: r.id, reason: `${m.replace("frame_ms_", "")}: ${r.reason}` })) })
    return (
        <div>
            <LineChart title="Frame time: p50, p95 and p99" unit="ms" series={series} bands={bands} lines={lines} markers={markers} sync={sync} onPointClick={(p) => onOpen(p.id)} height={260} />
            <p className="mt-1 px-1 text-[11px] text-dim">{infoOf("frame_ms").desc} <span className="text-muted">Good: {infoOf("frame_ms").good}</span></p>
        </div>
    )
}

function HeatmapView({ runs, metrics, onOpen }: { runs: RunRow[]; metrics: string[]; onOpen: (id?: number | string) => void }) {
    const h = useMemo(() => heatmap(runs, metrics.slice(0, 24)), [runs, metrics])
    if (h.runs.length < 4) return null
    return (
        <Heatmap title="Regression heatmap: metric by run" cols={h.runs.map((r) => String(r.id))} onCell={(_, id) => onOpen(id)}
            rows={h.rows.map((r) => ({ key: r.metric, label: r.metric, cells: r.cells.map((c) => ({ z: c.z, flag: c.flag, id: c.id, tip: `${r.metric} in run #${c.id}: ${c.value === null ? "not recorded" : fmt(c.value, unitOf(r.metric))}${c.z === null ? " (no baseline yet)" : `, ${fmtPct(c.z)} ${c.z > 0 ? "worse" : "better"} than the previous 5 runs`}` })) }))} />
    )
}

function Distribution({ runs, metrics }: { runs: RunRow[]; metrics: string[] }) {
    const [m, setM] = useState(metrics.includes("frame_ms_p95") ? "frame_ms_p95" : metrics[0])
    const vals = seriesOf(runs, m).map((p) => p.value)
    if (vals.length < 5) return null
    const h = histogram(vals, 10), unit = unitOf(m)
    return (
        <div className="rounded-lg border border-line bg-panel/40 p-3">
            <div className="flex items-center gap-2 text-[13px]">Distribution across runs<select aria-label="Metric" className="ml-auto rounded border border-line bg-panel px-2 py-0.5 text-[12px]" value={m} onChange={(e) => setM(e.target.value)}>{metrics.map((x) => <option key={x}>{x}</option>)}</select></div>
            <p className="mb-2 text-[11px] text-muted">How the per-run values of {m} spread over the {vals.length} runs shown. Per-frame distributions are on each run page.</p>
            <BarList unit="" rows={h.bins.map((b, i) => ({ key: String(i), label: `${fmt(b.lo)}-${fmt(b.hi)} ${unit}`, value: b.n, color: PALETTE.single }))} max={h.max} />
        </div>
    )
}

function Compare({ runs, budgets, game }: { runs: RunRow[]; budgets: unknown[]; game: string }) {
    const [a, setA] = useState<number | null>(null)
    const [b, setB] = useState<number | null>(null)
    const ra = runs.find((r) => r.id === (a ?? runs[Math.max(0, runs.length - 2)]?.id)), rb = runs.find((r) => r.id === (b ?? runs[runs.length - 1]?.id))
    const rows = ra && rb ? diffRuns(ra, rb, budgets as never[]) : []
    const sel = (v: number | undefined, set: (n: number) => void, label: string) => <select aria-label={label} className="rounded border border-line bg-panel px-2 py-0.5 text-[12px]" value={v} onChange={(e) => set(Number(e.target.value))}>{[...runs].reverse().map((r) => <option key={r.id} value={r.id}>#{r.id} {String(r.ranAt).slice(0, 10)} {r.commit.slice(0, 7)}</option>)}</select>
    const VC: Record<string, string> = { better: "text-emerald-300", worse: "text-red-300", same: "text-muted", new: "text-sky-300", gone: "text-muted" }
    const VI: Record<string, string> = { better: "▲ better", worse: "▼ worse", same: "= same", new: "+ new", gone: "- gone" }
    return (
        <details className="rounded-lg border border-line bg-panel/40 p-3">
            <summary className="cursor-pointer text-[13px]">Compare two runs</summary>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-dim">baseline {sel(ra?.id, setA, "Baseline run")} vs {sel(rb?.id, setB, "Compared run")}{ra && rb && <Link className="ml-auto text-sky-300 hover:underline" href={`/perf/${game}/run/${rb.id}?vs=${ra.id}`}>flame diff {"→"}</Link>}</div>
            <table className="mt-2 w-full text-[12px]">
                <thead className="text-left text-muted"><tr><th className="py-1">Metric</th><th className="text-right">A</th><th className="text-right">B</th><th className="text-right">Change</th><th className="pl-3">Verdict</th><th>Budget</th></tr></thead>
                <tbody>{rows.map((r) => <tr key={r.metric} className="border-t border-line"><td className="py-1 font-mono">{r.metric}</td><td className="text-right tabular-nums">{fmt(r.a)}</td><td className="text-right tabular-nums">{fmt(r.b)}</td><td className="text-right tabular-nums">{r.pct === null ? "-" : fmtPct(r.pct)}</td><td className={`pl-3 ${VC[r.verdict]}`}>{VI[r.verdict]}</td><td>{r.budget ? (r.budget.ok ? <span className="text-emerald-300">{"✓"} {r.budget.kind} {fmt(r.budget.limit)}</span> : <span className="text-red-300">{"✗"} {r.budget.kind} {fmt(r.budget.limit)}</span>) : <span className="text-muted">-</span>}</td></tr>)}</tbody>
            </table>
        </details>
    )
}
