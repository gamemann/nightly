"use client"
import { useMemo, useState } from "react"
import { api, type RouterOutputs } from "~/trpc/react"
import { ago } from "./pills"
import { Pagination, useUrlParams } from "./Pagination"
import { DEFAULT_SIZE, PAGE_SIZES, paged } from "~/lib/paging"

// Claude Code token usage. Data comes from `nightly usage ingest` (local sqlite copy, optionally mirrored to ClickHouse); every figure is a count
// from the transcripts and every dollar figure an ESTIMATE from the editable price table. No message text is ever stored or shown.
const input = "rounded border border-line bg-panel px-2 py-1 text-[12px] outline-none focus:border-sky-400/60"
const btn = "rounded border border-line px-2 py-1 text-[12px] hover:bg-hover disabled:opacity-40"
// Categorical slots in fixed order (dataviz reference palette, dark steps). Colour follows the entity: kinds and models keep their slot.
const SLOT = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#0ca30c", "#9085e9", "#e66767"]
const KIND_LABEL: Record<string, string> = { input: "fresh input", output: "output", cache_read: "cache read", cache_5m: "cache write 5m", cache_1h: "cache write 1h" }
const DIM_TABS: [string, string][] = [["project", "Project"], ["session", "Session"], ["agent_type", "Agent type"], ["model", "Model"], ["tool", "Tool"], ["skill", "Skill / prompt"], ["branch", "Branch"]]
const RANGES: [string, number][] = [["24h", 1], ["7d", 7], ["30d", 30], ["90d", 90], ["all", 0]]

const fmt = (n: number) => (n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n)))
const usd = (n: number) => (n >= 100 ? "$" + Math.round(n).toLocaleString() : "$" + n.toFixed(2))
const when = (ms: number) => (ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "-")

export function Usage() {
    const [days, setDays] = useState(30)
    const [unit, setUnit] = useState<"day" | "hour">("day")
    const [by, setBy] = useState<"kind" | "model">("kind")
    const [filter, setFilter] = useState<Record<string, string> | undefined>()
    const state = api.usage.state.useQuery(undefined, { refetchInterval: 60_000 })
    const utils = api.useUtils()
    const ingest = api.usage.ingest.useMutation({ onSuccess: () => void utils.usage.invalidate() })
    const has = state.data?.tables && (state.data.rows.messages > 0)
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-[15px] font-semibold tracking-tight">Usage</h1>
                <span className="rounded bg-hover px-1.5 text-[11px] text-muted">{state.data?.source === "ch" ? "ClickHouse" : state.data?.source === "sqlite" ? "local sqlite" : "no data yet"}</span>
                {state.data?.lastIngestAt && <span className="text-[11px] text-muted">ingested {ago(state.data.lastIngestAt)}</span>}
                <div className="ml-auto flex gap-1">
                    {RANGES.map(([l, d]) => <button key={l} onClick={() => setDays(d)} className={`${btn} ${days === d ? "bg-hover text-sky-300" : ""}`}>{l}</button>)}
                    <button className={btn} disabled={ingest.isPending} onClick={() => ingest.mutate({ full: false })}>{ingest.isPending ? "Ingesting…" : "Ingest now"}</button>
                </div>
            </div>
            <p className="mt-0.5 mb-3 text-[12px] text-muted">Where Claude Code tokens go, from your local transcripts. Counts are exact; dollar figures are estimates from the price table below; tool-result sizes are estimated from text length.</p>
            {ingest.error && <div className="mb-3 rounded border border-red-400/40 p-2 text-red-300">{ingest.error.message}</div>}
            {ingest.data && <div className="mb-3 rounded border border-line p-2 text-[12px] text-muted">Ingest: {ingest.data.changed}/{ingest.data.files} files changed, {ingest.data.messages} messages{ingest.data.chError ? `; ClickHouse push failed, rows stay queued: ${ingest.data.chError}` : ""}</div>}
            {state.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
            {state.error && <div className="rounded border border-red-400/40 p-3 text-red-300">{state.error.message}</div>}
            {state.data && !has && <Setup s={state.data} />}
            {state.data && has && (
                <>
                    {state.data.chError && <div className="mb-3 rounded border border-amber-400/40 p-2 text-[12px] text-amber-300">ClickHouse is enabled but not answering ({state.data.chError}); showing the local copy.</div>}
                    {filter && <div className="mb-3 flex items-center gap-2 text-[12px]">Filtered: <code>{Object.entries(filter).map(([k, v]) => `${k}=${v}`).join(", ")}</code><button className={btn} onClick={() => setFilter(undefined)}>clear</button></div>}
                    <Overview days={days} unit={unit} setUnit={setUnit} by={by} setBy={setBy} />
                    <Tables days={days} filter={filter} setFilter={setFilter} />
                    <Runs days={days} />
                </>
            )}
            {state.data && <Config s={state.data} />}
        </div>
    )
}

function Setup({ s }: { s: RouterOutputs["usage"]["state"] }) {
    return (
        <div className="rounded-lg border border-line bg-panel/40 p-4 text-[13px]">
            <div className="mb-1 font-medium">No usage data yet</div>
            <ol className="list-decimal space-y-1 pl-5 text-muted">
                <li>Click <b>Ingest now</b> (or run <code>nightly usage ingest</code>). It reads Claude Code transcripts from <code>{s.settings.usageDirs || "~/.claude/projects"}</code> into the local database, so this tab works without ClickHouse.</li>
                <li>Optional, for large histories: <code>docker compose up -d clickhouse</code>, then set <code>usageChEnabled</code> to <code>true</code> below (url, database, user and the <i>name</i> of the password env var are settings; the password itself stays in the environment).</li>
                <li>Optional: set <code>usageAutoIngestMinutes</code> so the scheduler ingests on its own, or POST <code>/api/usage/ingest</code> from cron.</li>
            </ol>
            <div className="mt-2 text-[12px] text-muted">ClickHouse: {s.clickhouse.enabled ? "enabled" : "not configured"} · tables: {s.tables ? "present" : "missing (run nightly usage ingest)"} · rows: {s.rows.messages}</div>
        </div>
    )
}

// ---------- totals, chart, insights ----------

function Overview({ days, unit, setUnit, by, setBy }: { days: number; unit: "day" | "hour"; setUnit: (u: "day" | "hour") => void; by: "kind" | "model"; setBy: (b: "kind" | "model") => void }) {
    const q = api.usage.overview.useQuery({ days, unit }, { refetchInterval: 60_000 })
    if (q.isLoading) return <div className="p-6 text-center text-muted">Loading…</div>
    if (q.error) return <div className="rounded border border-red-400/40 p-3 text-red-300">{q.error.message}</div>
    const d = q.data
    if (!d) return null
    return (
        <>
            <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
                {(["today", "7d", "30d", "all"] as const).map((k) => (
                    <div key={k} className="rounded-lg border border-line bg-panel/40 p-3">
                        <div className="text-[11px] uppercase tracking-wide text-muted">{k}</div>
                        <div className="text-[20px] font-semibold tabular-nums">{fmt(d.totals[k].total)}</div>
                        <div className="text-[12px] text-muted">{usd(d.totals[k].cost)} est. · {fmt(d.totals[k].messages)} msgs</div>
                    </div>
                ))}
            </div>
            <Chart series={d.series} unit={unit} setUnit={setUnit} by={by} setBy={setBy} />
            <Insights items={d.insights} />
        </>
    )
}

type Series = NonNullable<RouterOutputs["usage"]["overview"]>["series"]
function Chart({ series, unit, setUnit, by, setBy }: { series: Series; unit: "day" | "hour"; setUnit: (u: "day" | "hour") => void; by: "kind" | "model"; setBy: (b: "kind" | "model") => void }) {
    const [hover, setHover] = useState<number | null>(null)
    const [table, setTable] = useState(false)
    const { keys, rows, max } = useMemo(() => {
        const rows = series.buckets.map((b) => ({ t: b.t, v: (by === "kind" ? b.byKind : b.byModel) as Record<string, number>, cost: b.cost }))
        const sum: Record<string, number> = {}
        for (const r of rows) for (const [k, v] of Object.entries(r.v)) sum[k] = (sum[k] ?? 0) + v
        let keys = Object.keys(sum).sort((a, b) => sum[b] - sum[a])
        if (by === "model" && keys.length > 8) keys = keys.slice(0, 7).concat("other")
        const fold = (v: Record<string, number>) => { const o: Record<string, number> = {}; for (const [k, n] of Object.entries(v)) { const kk = keys.includes(k) ? k : "other"; o[kk] = (o[kk] ?? 0) + n } return o }
        const folded = rows.map((r) => ({ ...r, v: by === "model" ? fold(r.v) : r.v }))
        return { keys, rows: folded, max: Math.max(1, ...folded.map((r) => Object.values(r.v).reduce((a, b) => a + b, 0))) }
    }, [series, by])
    const W = 960, H = 220, L = 46, B = 22, T = 8
    const bw = rows.length ? (W - L) / rows.length : 0
    const y = (v: number) => T + (H - T - B) * (1 - v / max)
    const color = (k: string) => SLOT[Math.min(keys.indexOf(k), 7)] ?? SLOT[7]
    const hv = hover !== null ? rows[hover] : null
    return (
        <div className="mb-4 rounded-lg border border-line bg-panel/40 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2 text-[12px]">
                <span className="font-medium">Tokens over time</span>
                <Toggle v={by} set={setBy} opts={[["kind", "by kind"], ["model", "by model"]]} />
                <Toggle v={unit} set={setUnit} opts={[["day", "daily"], ["hour", "hourly"]]} />
                <button className={`${btn} ml-auto`} onClick={() => setTable(!table)}>{table ? "chart" : "table"}</button>
            </div>
            {rows.length === 0 && <div className="py-8 text-center text-muted">No data in this range.</div>}
            {rows.length > 0 && !table && (
                <>
                    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Stacked token usage over time" onMouseLeave={() => setHover(null)}>
                        {[0, 0.5, 1].map((f) => <g key={f}><line x1={L} x2={W} y1={y(max * f)} y2={y(max * f)} stroke="#22252e" strokeWidth={1} /><text x={L - 6} y={y(max * f) + 3} textAnchor="end" fontSize={10} fill="#6c717c">{fmt(max * f)}</text></g>)}
                        {rows.map((r, i) => {
                            let acc = 0
                            return (
                                <g key={r.t}>
                                    {keys.map((k) => {
                                        const v = r.v[k] ?? 0
                                        if (!v) return null
                                        const y1 = y(acc + v), h = y(acc) - y1
                                        acc += v
                                        return <rect key={k} x={L + i * bw + 1} width={Math.max(1, bw - 2)} y={y1} height={Math.max(0, h - 1)} fill={color(k)} opacity={hover === null || hover === i ? 1 : 0.55} />
                                    })}
                                    <rect x={L + i * bw} width={bw} y={T} height={H - T - B} fill="transparent" onMouseEnter={() => setHover(i)} />
                                </g>
                            )
                        })}
                        {[0, Math.floor(rows.length / 2), rows.length - 1].map((i) => rows[i] && <text key={i} x={L + i * bw + bw / 2} y={H - 6} textAnchor={i === 0 ? "start" : i === rows.length - 1 ? "end" : "middle"} fontSize={10} fill="#6c717c">{rows[i].t.slice(unit === "hour" ? 5 : 0, 16)}</text>)}
                    </svg>
                    <div className="mt-1 flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                        {keys.map((k) => <span key={k} className="inline-flex items-center gap-1"><span className="inline-block size-2.5 rounded-sm" style={{ background: color(k) }} />{by === "kind" ? KIND_LABEL[k] ?? k : k}</span>)}
                        {hv && <span className="ml-auto font-mono text-muted">{hv.t} · {fmt(Object.values(hv.v).reduce((a, b) => a + b, 0))} · {usd(hv.cost)} est.</span>}
                    </div>
                </>
            )}
            {rows.length > 0 && table && (
                <div className="max-h-64 overflow-auto"><table className="w-full text-[12px]"><thead className="text-left text-muted"><tr><th>bucket</th>{keys.map((k) => <th key={k} className="text-right">{KIND_LABEL[k] ?? k}</th>)}<th className="text-right">est. cost</th></tr></thead>
                    <tbody>{rows.map((r) => <tr key={r.t} className="border-t border-line"><td className="font-mono">{r.t}</td>{keys.map((k) => <td key={k} className="text-right tabular-nums">{fmt(r.v[k] ?? 0)}</td>)}<td className="text-right tabular-nums">{usd(r.cost)}</td></tr>)}</tbody></table></div>
            )}
        </div>
    )
}

function Toggle<T extends string>({ v, set, opts }: { v: T; set: (v: T) => void; opts: [T, string][] }) {
    return <span className="inline-flex overflow-hidden rounded border border-line">{opts.map(([k, l]) => <button key={k} onClick={() => set(k)} className={`px-2 py-0.5 text-[11px] hover:bg-hover ${v === k ? "bg-hover text-sky-300" : "text-muted"}`}>{l}</button>)}</span>
}

type Ins = NonNullable<RouterOutputs["usage"]["overview"]>["insights"]
function Insights({ items }: { items: Ins }) {
    return (
        <div className="mb-4 rounded-lg border border-line bg-panel/40 p-3">
            <div className="mb-2 text-[12px] font-medium">Where it goes</div>
            {items.length === 0 && <div className="text-muted">Nothing stands out in this range.</div>}
            <div className="grid gap-2 md:grid-cols-2">
                {items.map((i) => (
                    <div key={i.id} className={`rounded border p-2 ${i.level === "warn" ? "border-amber-400/40" : "border-line"}`}>
                        <div className="text-[13px]"><span className={i.level === "warn" ? "text-amber-300" : "text-sky-300"}>{i.level === "warn" ? "▲" : "●"}</span> {i.title}</div>
                        {i.detail && <div className="text-[12px] text-muted">{i.detail}</div>}
                        <div className="mt-1 text-[12px]">Try: <span className="text-dim">{i.suggestion}</span></div>
                    </div>
                ))}
            </div>
        </div>
    )
}

// ---------- breakdown tables ----------

function Tables({ days, filter, setFilter }: { days: number; filter?: Record<string, string>; setFilter: (f?: Record<string, string>) => void }) {
    const [dim, setDim] = useState("project")
    const [sort, setSort] = useState<string>("total")
    const [asc, setAsc] = useState(false)
    const { sp, set } = useUrlParams()
    const size = (PAGE_SIZES as readonly number[]).includes(Number(sp.get("size"))) ? Number(sp.get("size")) : DEFAULT_SIZE
    const page = Math.max(1, Math.floor(Number(sp.get("page"))) || 1)
    const ssize = (PAGE_SIZES as readonly number[]).includes(Number(sp.get("ssize"))) ? Number(sp.get("ssize")) : DEFAULT_SIZE
    const spage = Math.max(1, Math.floor(Number(sp.get("spage"))) || 1)
    const q = api.usage.breakdown.useQuery({ days, dim, filter, page, size, sort, dir: asc ? "asc" : "desc" }, { placeholderData: (p) => p })
    const sess = api.usage.sessions.useQuery({ days, filter, page: spage, size: ssize }, { enabled: !!filter, placeholderData: (p) => p })
    const pageRows = q.data?.page
    const rows = pageRows?.rows ?? []
    const isTool = dim === "tool"
    const cols: [string, string][] = isTool ? [["calls", "calls"], ["total", "result tokens"], ["biggest", "biggest"], ["errors", "errors"]] : [["messages", "msgs"], ["input", "fresh in"], ["output", "out"], ["cache_read", "cache read"], ["total", "total"], ["cost", "est. cost"]]
    const th = (k: string, l: string) => <th key={k} className="cursor-pointer select-none px-2 py-1 text-right hover:text-fg" onClick={() => { set({}); if (sort === k) setAsc(!asc); else { setSort(k); setAsc(false) } }}>{l}{sort === k ? (asc ? " ▲" : " ▼") : ""}</th>
    return (
        <div className="mb-4 rounded-lg border border-line bg-panel/40 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-1 text-[12px]">
                {DIM_TABS.map(([k, l]) => <button key={k} onClick={() => { set({}); setDim(k); setSort("total"); setAsc(false) }} className={`${btn} ${dim === k ? "bg-hover text-sky-300" : ""}`}>{l}</button>)}
                {q.data?.estimated && <span className="ml-2 text-[11px] text-muted">sizes are estimates</span>}
            </div>
            {q.error && <div className="text-red-300">{q.error.message}</div>}
            <div className="overflow-auto">
                <table className="w-full text-[12px]">
                    <thead className="text-muted"><tr><th className="px-2 py-1 text-left">{dim}</th>{cols.map(([k, l]) => th(k, l))}<th className="w-40 px-2 py-1 text-left">share</th></tr></thead>
                    <tbody>
                        {rows.map((r) => (
                            <tr key={String(r.key)} className="border-t border-line hover:bg-hover">
                                <td className="max-w-xs truncate px-2 py-1 font-mono">
                                    {dim === "tool" ? String(r.key) : <button className="hover:text-sky-300" title="drill into this row's sessions" onClick={() => setFilter({ [dim]: String(r.key) })}>{String(r.key) || "(none)"}</button>}
                                </td>
                                {cols.map(([k]) => <td key={k} className="px-2 py-1 text-right tabular-nums">{k === "cost" ? usd(Number(r[k])) : fmt(Number(r[k] ?? 0))}</td>)}
                                <td className="px-2 py-1"><div className="h-2 rounded-sm bg-hover"><div className="h-2 rounded-sm" style={{ width: `${Math.min(100, Number(r.share ?? 0) * 100)}%`, background: SLOT[0] }} /></div></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                {pageRows?.total === 0 && !q.isLoading && <div className="py-4 text-center text-muted">No rows.</div>}
                {pageRows && pageRows.total > 0 && <Pagination p={pageRows} />}
            </div>
            {filter && (
                <div className="mt-3">
                    <div className="mb-1 text-[12px] font-medium">Sessions</div>
                    <table className="w-full text-[12px]"><thead className="text-left text-muted"><tr><th className="px-2">session</th><th>project</th><th>branch</th><th>last</th><th className="text-right">msgs</th><th className="text-right">total</th><th className="text-right">est.</th></tr></thead>
                        <tbody>{sess.data?.rows.map((s) => <tr key={s.key} className="border-t border-line"><td className="px-2 font-mono">{s.key.slice(0, 8)}</td><td>{s.project}</td><td>{s.branch}</td><td>{when(s.last)}</td><td className="text-right tabular-nums">{s.messages + s.subMessages}</td><td className="text-right tabular-nums">{fmt(s.total)}</td><td className="text-right tabular-nums">{usd(s.cost)}</td></tr>)}</tbody></table>
                </div>
            )}
        </div>
    )
}

function Runs({ days }: { days: number }) {
    const q = api.usage.runs.useQuery({ days })
    if (!q.data || q.data.total.runs === 0) return null
    const t = q.data.total
    return <div className="mb-4 rounded-lg border border-line bg-panel/40 p-3 text-[12px]"><span className="font-medium">Scheduled runs</span> <span className="text-muted">(Nightly's own runner, recorded cost): {t.runs} runs · {t.turns} turns · {Math.round(t.minutes)} min · {usd(t.costUsd)}</span></div>
}

// ---------- prices and settings ----------

function Config({ s }: { s: RouterOutputs["usage"]["state"] }) {
    const utils = api.useUtils()
    const [json, setJson] = useState<string | null>(null)
    const save = api.usage.setPrices.useMutation({ onSuccess: () => { setJson(null); void utils.usage.invalidate() } })
    const setSetting = api.setting.set.useMutation({ onSuccess: () => void utils.usage.invalidate() })
    const text = json ?? JSON.stringify(s.prices, null, 2)
    const [k, setK] = useState("usageChEnabled")
    const [v, setV] = useState("")
    return (
        <details className="mb-6 rounded-lg border border-line bg-panel/40 p-3 text-[12px]">
            <summary className="cursor-pointer font-medium">Prices and settings</summary>
            <p className="mt-2 text-muted">Estimated USD per million tokens by model name (substring match, <code>*</code> is the fallback). Defaults are generic placeholders; edit them to your plan. Not a bill.</p>
            <textarea className={`${input} mt-1 h-48 w-full font-mono`} value={text} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
            <div className="mt-1 flex items-center gap-2"><button className={btn} disabled={json === null || save.isPending} onClick={() => save.mutate({ json: text })}>Save prices</button>{save.error && <span className="text-red-300">{save.error.message}</span>}</div>
            <div className="mt-3 text-muted">ClickHouse: {s.clickhouse.enabled ? "enabled" : "off"} · {s.clickhouse.url} · db {s.clickhouse.db} · user {s.clickhouse.user} · password env {s.clickhouse.passwordEnv} ({s.clickhouse.passwordSet ? "set" : "not set"})</div>
            <div className="mt-2 flex flex-wrap items-center gap-1">
                <select className={input} value={k} onChange={(e) => { setK(e.target.value); setV(s.settings[e.target.value] ?? "") }}>
                    {["usageChEnabled", "usageChUrl", "usageChDb", "usageChUser", "usageChPasswordEnv", "usageDirs", "usageProjectMode", "usageAutoIngestMinutes", "usagePollMin", "usageBigResultTokens"].map((x) => <option key={x}>{x}</option>)}
                </select>
                <input className={`${input} w-72`} value={v} placeholder="value" onChange={(e) => setV(e.target.value)} />
                <button className={btn} disabled={setSetting.isPending} onClick={() => setSetting.mutate({ key: k, value: v })}>Set</button>
                <span className="text-muted">dirs: comma/newline separated; projectMode: basename | hash | none</span>
            </div>
        </details>
    )
}
