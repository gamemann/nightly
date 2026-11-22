import Link from "next/link"
import type { Board, DomainStat, Finding } from "~/server/rsiBoard"
import { TIERS } from "~/server/rsiBoard"

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
        <a href={`#d-${d.domain}`} className="rounded-lg border border-line bg-panel/60 p-3 hover:bg-hover/40">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-dim">{d.domain}</div>
            <div className="mt-1.5 flex items-baseline gap-3 text-[12px]">
                <span><b className="text-[18px] text-red-300">{d.open}</b> found</span>
                <span><b className="text-[18px] text-amber-300">{d.fixed}</b> fixed</span>
                <span><b className="text-[18px] text-emerald-300">{d.remeasured}</b> remeasured</span>
            </div>
            <div className="mt-1 text-[11px] text-dim">{d.delta != null ? `average change ${d.delta > 0 ? "+" : ""}${num(d.delta)}${d.deltaUnit} on remeasured` : d.findings.length ? "no remeasured finding yet" : "no auditor data"}</div>
        </a>
    )
}

function FindingRow({ f }: { f: Finding }) {
    return (
        <tr className="border-t border-line/60 align-top">
            <td className="py-1.5 pr-3"><Link href={f.href} className="hover:underline">{f.subject}</Link></td>
            <td className="pr-3"><span className={`rounded px-1.5 py-px text-[11px] ${sevCls(f.severity)}`}>{f.code}</span>{f.tier && <span className="ml-1 text-[10px] text-muted">{f.tier}</span>}</td>
            <td className={`pr-3 ${STATE_CLS[f.state] ?? ""}`}>{f.state}</td>
            <td className="pr-3"><Delta f={f} /></td>
            <td className="text-dim">{f.nextAction}</td>
        </tr>
    )
}

function DomainSection({ d }: { d: DomainStat }) {
    const shown = d.findings.slice(0, 15)
    return (
        <section id={`d-${d.domain}`} className="mb-6">
            <h2 className="mb-1 text-[13px] font-semibold capitalize">{d.domain} <span className="font-normal text-dim">({d.findings.length} findings)</span></h2>
            {d.note && <p className="text-[12px] text-dim">{d.note}</p>}
            {shown.length > 0 && (
                <table className="w-full text-left text-[12px]">
                    <thead className="text-[11px] text-muted"><tr><th className="pr-3 font-normal">Subject</th><th className="pr-3 font-normal">Finding</th><th className="pr-3 font-normal">State</th><th className="pr-3 font-normal">{d.domain === "perf" ? "Before to after" : "Score before to after"}</th><th className="font-normal">Next action</th></tr></thead>
                    <tbody>{shown.map((f) => <FindingRow key={`${f.domain}${f.id}`} f={f} />)}</tbody>
                </table>
            )}
            {d.findings.length > shown.length && <p className="mt-1 text-[11px] text-muted">{d.findings.length - shown.length} more: open the asset in <Link href="/assets" className="underline">Assets</Link>.</p>}
        </section>
    )
}

export function RsiBoard({ b }: { b: Board }) {
    return (
        <div className="mx-auto max-w-6xl px-6 py-6">
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
            <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">{b.domains.map((d) => <DomainCard key={d.domain} d={d} />)}</div>
            <section className="mb-6">
                <h2 className="mb-1 text-[13px] font-semibold">Worst-scoring assets first</h2>
                <table className="w-full text-left text-[12px]">
                    <thead className="text-[11px] text-muted"><tr><th className="pr-3 font-normal">Asset</th><th className="pr-3 font-normal">Score</th><th className="pr-3 font-normal">Open flags</th><th className="font-normal">Next action</th></tr></thead>
                    <tbody>
                        {b.worst.map((w) => (
                            <tr key={w.subject} className="border-t border-line/60 align-top">
                                <td className="py-1.5 pr-3">{w.assetId ? <Link href={`/assets/${w.assetId}`} className="hover:underline">{w.subject}</Link> : w.subject}</td>
                                <td className={`pr-3 tabular-nums ${scoreCls(w.score)}`}>{Math.round(w.score)}{w.before != null && w.before !== w.score && <span className="text-muted"> (was {Math.round(w.before)})</span>}</td>
                                <td className="pr-3">{w.codes.map((c) => <span key={`${c.code}${c.tier}`} className={`mr-1 inline-block rounded px-1.5 py-px text-[11px] ${sevCls(c.severity)}`}>{c.code}{c.tier ? ` ${c.tier}` : ""}</span>)}</td>
                                <td className="text-dim">{w.nextAction}</td>
                            </tr>
                        ))}
                        {!b.worst.length && <tr><td colSpan={4} className="py-2 text-dim">No open asset findings{b.lastRefresh ? "." : ": the first scheduled audit refresh has not run yet (nightly rsi refresh)."}</td></tr>}
                    </tbody>
                </table>
            </section>
            <section className="mb-6 rounded-lg border border-line p-3">
                <h2 className="mb-1 text-[13px] font-semibold">Blockers <span className="font-normal text-dim">({b.blockers.length}): stale, duplicate and blocked items, each with its next action</span></h2>
                {b.blockers.length === 0 && <p className="text-[12px] text-dim">No blockers detected.</p>}
                <table className="w-full text-left text-[12px]"><tbody>
                    {b.blockers.map((x) => (
                        <tr key={x.id} className="border-t border-line/60 align-top">
                            <td className="py-1.5 pr-3"><Link href={x.href} className="hover:underline">{x.subject}</Link></td>
                            <td className="pr-3"><span className={`rounded px-1.5 py-px text-[11px] ${sevCls(x.severity)}`}>{x.code}</span></td>
                            <td className="pr-3 text-dim">{x.msg}</td>
                            <td>{x.nextAction}</td>
                        </tr>
                    ))}
                </tbody></table>
            </section>
            {b.domains.map((d) => <DomainSection key={d.domain} d={d} />)}
        </div>
    )
}
