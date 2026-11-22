"use client"
import Link from "next/link"
import { BarList, Donut } from "./PerfChart"
import { OverviewStats } from "./OverviewStats"
import { FindingsTable } from "./FindingsTable"
import { DataTable, type Column } from "./DataTable"
import type { PageQuery } from "~/lib/paging"
import type { Board, DomainStat, Finding, WorstAsset } from "~/server/rsiBoard"
import { TIERS } from "~/lib/rsiDomains"

const scoreCls = (s: number) => (s >= 70 ? "text-emerald-300" : s >= 40 ? "text-amber-300" : "text-red-300")
const sevCls = (s: string) => (s === "error" ? "bg-red-400/15 text-red-300" : s === "warn" ? "bg-amber-400/15 text-amber-300" : "bg-hover text-dim")
const STATE_CLS: Record<string, string> = { found: "text-red-300", fixed: "text-amber-300", remeasured: "text-emerald-300" }
const num = (n: number | null) => (n == null ? "-" : Number.isInteger(n) ? String(n) : n.toFixed(2))

function Delta({ f }: { f: Finding }) {
    if (f.before == null && f.after == null) return <span className="text-muted">-</span>
    const d = f.before != null && f.after != null ? f.after - f.before : null
    return (
        <span className="tabular-nums">
            {num(f.before)} <span className="text-muted">to</span> {num(f.after)}
            {d != null && d !== 0 && <span className={d > 0 === (f.domain !== "perf") ? " text-emerald-300" : " text-red-300"}> ({d > 0 ? "+" : ""}{num(d)})</span>}
        </span>
    )
}

function DomainCard({ d }: { d: DomainStat }) {
    return (
        <a href={`/?domain=${d.domain}#findings`} className="rounded-lg border border-line bg-panel/60 p-3 hover:bg-hover/40">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">{d.domain}</div>
            <div className="mt-1.5 flex items-baseline gap-3 text-[12px]">
                <span><b className="text-[18px] text-red-300">{d.open}</b> found</span>
                <span><b className="text-[18px] text-amber-300">{d.fixed}</b> fixed</span>
                <span><b className="text-[18px] text-emerald-300">{d.remeasured}</b> remeasured</span>
            </div>
            <div className="mt-1 text-[11px] text-dim">{d.delta != null ? `average change ${d.delta > 0 ? "+" : ""}${num(d.delta)}${d.deltaUnit} on remeasured` : d.total ? "no remeasured finding yet" : "no auditor data"}</div>
        </a>
    )
}

const WORST_COLS: Column<WorstAsset>[] = [
    { key: "subject", label: "Asset", sortable: true, render: (w) => (w.assetId ? <Link href={`/assets/${w.assetId}`} className="hover:underline">{w.subject}</Link> : w.subject) },
    { key: "score", label: "Score", sortable: true, className: "tabular-nums", render: (w) => <span className={scoreCls(w.score)}>{Math.round(w.score)}{w.before != null && w.before !== w.score && <span className="text-muted"> (was {Math.round(w.before)})</span>}</span> },
    { key: "codes", label: "Open flags", render: (w) => <>{w.codes.map((c) => <span key={`${c.code}${c.tier}`} className={`mr-1 inline-block rounded px-1.5 py-px text-[11px] ${sevCls(c.severity)}`}>{c.code}{c.tier ? ` ${c.tier}` : ""}</span>)}</> },
    { key: "next", label: "Next action", className: "text-dim", render: (w) => w.nextAction },
]
const BLOCKER_COLS: Column<Finding>[] = [
    { key: "subject", label: "Subject", sortable: true, render: (x) => <Link href={x.href} className="hover:underline">{x.subject}</Link> },
    { key: "code", label: "Code", sortable: true, render: (x) => <span className={`rounded px-1.5 py-px text-[11px] ${sevCls(x.severity)}`}>{x.code}</span> },
    { key: "severity", label: "Severity", sortable: true, className: "text-dim", render: (x) => x.severity },
    { key: "msg", label: "Detail", className: "text-dim", render: (x) => x.msg },
    { key: "next", label: "Next action", render: (x) => x.nextAction },
]

export function RsiBoard({ b, q, bq, wq }: { b: Board; q: PageQuery; bq: PageQuery; wq: PageQuery }) {
    return (
        <div className="mx-auto max-w-6xl px-6 py-6">
            <OverviewStats />
            <div className="mb-4 flex flex-wrap items-baseline justify-between gap-3">
                <div>
                    <h1 className="text-[18px] font-semibold tracking-tight">RSI board</h1>
                    <p className="text-[12px] text-dim">Detect, fix, remeasure. Findings come from the scheduled audit; last refresh {b.lastRefresh ? new Date(b.lastRefresh).toLocaleString() : "never"}.</p>
                </div>
                <div className="flex items-center gap-1 text-[12px]" title="Texture findings are judged against this video-settings tier">
                    <span className="mr-1 text-dim">Texture tier</span>
                    {TIERS.map((t) => <Link key={t} href={`/?tier=${t}`} className={`rounded px-2 py-0.5 ${b.tier === t ? "bg-hover text-fg" : "text-dim hover:bg-hover/60"}`}>{t}</Link>)}
                </div>
            </div>
            {b.domains.some((d) => d.total > 0) && (
                <div className="mb-6 grid gap-4 rounded-lg border border-line bg-panel/40 p-3 md:grid-cols-2">
                    <div><div className="mb-2 text-[13px]">Findings by state</div><Donut parts={[{ key: "found", label: "found (open)", value: b.domains.reduce((a, d) => a + d.open, 0), color: "#d55e00" }, { key: "fixed", label: "fixed, awaiting remeasure", value: b.domains.reduce((a, d) => a + d.fixed, 0), color: "#e69f00" }, { key: "remeasured", label: "remeasured", value: b.domains.reduce((a, d) => a + d.remeasured, 0), color: "#009e73" }]} /></div>
                    <div><div className="mb-2 text-[13px]">Open findings by domain</div><BarList rows={b.domains.map((d) => ({ key: d.domain, label: d.domain, value: d.open, color: "#d55e00" }))} /></div>
                </div>
            )}
            <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{b.domains.map((d) => <DomainCard key={d.domain} d={d} />)}</div>
            <section className="mb-6">
                <h2 className="mb-2 text-[13px] font-semibold">Worst-scoring assets first</h2>
                <DataTable ns="w" cols={WORST_COLS} data={b.worst} rowKey={(w) => w.subject} sort={wq.sort} dir={wq.dir} q={wq.q} searchHint="Search asset"
                    empty={`No open asset findings${b.lastRefresh ? "." : ": the first scheduled audit refresh has not run yet (nightly rsi refresh)."}`} />
            </section>
            <section className="mb-6">
                <h2 className="mb-1 text-[13px] font-semibold">Blockers <span className="font-normal text-dim">stale, duplicate and blocked items, each with its next action</span></h2>
                <DataTable ns="b" cols={BLOCKER_COLS} data={b.blockers} rowKey={(x) => x.id} sort={bq.sort} dir={bq.dir} q={bq.q} active={bq.f} searchHint="Search blockers" empty="No blockers detected."
                    filters={[{ key: "code", label: "Code", options: b.blockerCodes.map((value) => ({ value })) }, { key: "severity", label: "Severity", options: [{ value: "error" }, { value: "warn" }, { value: "info" }] }]} />
            </section>
            <section id="findings" className="mb-6">
                <h2 className="mb-2 text-[13px] font-semibold">All findings <span className="font-normal text-dim">(search, filter and sort; the database does the work)</span></h2>
                <FindingsTable data={b.findings} q={q} />
            </section>
        </div>
    )
}
