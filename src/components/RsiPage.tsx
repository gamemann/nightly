"use client"
import Link from "next/link"
import { DataTable, type Column } from "./DataTable"
import type { PageQuery } from "~/lib/paging"
import { RSI_DOMAINS, TIERS } from "~/lib/rsiDomains"
import type { RsiPageData, RsiRow } from "~/server/rsiPage"

const sevCls = (s: string) => (s === "error" ? "bg-red-400/15 text-red-300" : s === "warn" ? "bg-amber-400/15 text-amber-300" : "bg-hover text-dim")
const VERDICT_CLS: Record<string, string> = { pass: "text-emerald-300", unverified: "text-amber-300", fail: "text-red-300" }
const num = (n: number | null) => (n == null ? "-" : Number.isInteger(n) ? String(n) : n.toFixed(1))

function Trend({ r }: { r: RsiRow }) {
    if (r.trend == null) return <span className="text-muted">-</span>
    if (r.trend === 0) return <span className="text-muted">flat ({num(r.after)})</span>
    return <span className={`tabular-nums ${r.trend > 0 ? "text-emerald-300" : "text-red-300"}`}>{r.trend > 0 ? "up" : "down"} {num(r.before)} to {num(r.after)}</span>
}

const COLS: Column<RsiRow>[] = [
    { key: "subject", label: "Subject", sortable: true, render: (r) => <Link href={r.assetId ? `/assets/${r.assetId}` : "/assets"} className="hover:underline">{r.subject}</Link> },
    { key: "domain", label: "Domain", sortable: true, className: "text-dim", render: (r) => r.domain },
    { key: "code", label: "Finding", sortable: true, render: (r) => <><span className={`rounded px-1.5 py-px text-[11px] ${sevCls(r.severity)}`}>{r.code}</span>{r.tier && <span className="ml-1 text-[10px] text-muted">{r.tier}</span>}</> },
    { key: "status", label: "Status", sortable: true, render: (r) => r.status },
    { key: "verdict", label: "Verdict", render: (r) => <span className={VERDICT_CLS[r.verdict] ?? ""}>{r.verdict}</span> },
    { key: "trend", label: "Trend", sortable: true, render: (r) => <Trend r={r} /> },
    { key: "next", label: "Next action", className: "text-dim", render: (r) => r.nextAction },
]
const opts = (xs: readonly string[]) => xs.map((value) => ({ value }))

export function RsiPage({ d, q }: { d: RsiPageData; q: PageQuery }) {
    return (
        <div className="p-4">
            <h1 className="mb-3 text-lg font-semibold">RSI findings</h1>
            <div className="mb-3 flex flex-wrap gap-2">
                {d.domains.map((c) => (
                    <Link key={c.domain} href={`/rsi?domain=${c.domain}`} className="rounded-lg border border-line bg-panel/60 px-3 py-2 hover:bg-hover/40">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">{c.domain}</div>
                        <div className="text-[12px] tabular-nums"><span className={c.open ? "text-red-300" : "text-muted"}>{c.open} open</span> <span className="text-muted">/</span> <span className="text-emerald-300">{c.resolved} resolved</span></div>
                    </Link>
                ))}
            </div>
            <p className="mb-2 text-[12px] text-dim">Texture findings are judged per video-settings tier; showing <b>{d.tier}</b> ({TIERS.map((t) => <Link key={t} href={`/rsi?tier=${t}`} className="mr-1 underline">{t}</Link>)}).</p>
            <DataTable cols={COLS} data={d.findings} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search subject, code, message"
                empty="No findings: run nightly assets refresh."
                filters={[{ key: "domain", label: "Domain", options: opts(RSI_DOMAINS) }, { key: "status", label: "Status", options: opts(["open", "resolved"]) }, { key: "verdict", label: "Verdict", options: opts(["fail", "unverified", "pass"]) }]} />
        </div>
    )
}
