"use client"
import Link from "next/link"
import { DataTable, type Column } from "./DataTable"
import { DOMAINS } from "~/lib/rsiDomains"
import type { PageQuery, Paged } from "~/lib/paging"
import type { Finding } from "~/server/rsiBoard"

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

const FINDING_COLS: Column<Finding>[] = [
    { key: "subject", label: "Subject", sortable: true, render: (f) => <Link href={f.href} className="hover:underline">{f.subject}</Link> },
    { key: "domain", label: "Domain", sortable: true, className: "text-dim", render: (f) => f.domain },
    { key: "code", label: "Finding", sortable: true, render: (f) => <><span className={`rounded px-1.5 py-px text-[11px] ${sevCls(f.severity)}`}>{f.code}</span>{f.tier && <span className="ml-1 text-[10px] text-muted">{f.tier}</span>}</> },
    { key: "state", label: "State", sortable: true, render: (f) => <span className={STATE_CLS[f.state] ?? ""}>{f.state}</span> },
    { key: "after", label: "Before to after", sortable: true, render: (f) => <Delta f={f} /> },
    { key: "next", label: "Next action", className: "text-dim", render: (f) => f.nextAction },
]
const opts = (xs: readonly string[]) => xs.map((value) => ({ value }))


export function FindingsTable({ data, q }: { data: Paged<Finding>; q: PageQuery }) {
    return (
        <DataTable cols={FINDING_COLS} data={data} rowKey={(f) => `${f.domain}${f.id}`} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search subject, code, message"
            filters={[{ key: "domain", label: "Domain", options: opts(DOMAINS) }, { key: "state", label: "State", options: opts(["found", "fixed", "remeasured"]) }, { key: "severity", label: "Severity", options: opts(["error", "warn", "info"]) }, { key: "status", label: "Status", options: opts(["open", "resolved"]) }]} />
    )
}
