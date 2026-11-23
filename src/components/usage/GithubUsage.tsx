'use client'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { Empty, Err, Page, TH, ago } from '../ui/Page'
import { USAGE_TABS } from './tabs'

const SLOT = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181']
const RANGES: [string, number][] = [['6h', 6], ['24h', 24], ['48h', 48], ['7d', 168], ['30d', 720]]

/** Remaining-budget history per bucket as one SVG line chart (0..limit scaled to a percentage so buckets of different size share an axis). */
function Chart({ history, warn }: { history: { ts: number; bucket: string; remaining: number; limit: number }[]; warn: number }) {
    const W = 760, H = 180, P = 28
    if (history.length < 2) return <Empty>Not enough samples for a chart yet (one is taken hourly by the tick, or press Sample now).</Empty>
    const t0 = history[0]!.ts, t1 = history[history.length - 1]!.ts || t0 + 1
    const buckets = [...new Set(history.map((h) => h.bucket))]
    const x = (t: number) => P + ((t - t0) / Math.max(1, t1 - t0)) * (W - P - 8)
    const y = (pct: number) => H - 18 - (pct / 100) * (H - 28)
    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full rounded-lg border border-line bg-panel/40" role="img" aria-label="GitHub API remaining budget over time">
            {[0, 25, 50, 75, 100].map((p) => <g key={p}><line x1={P} x2={W - 8} y1={y(p)} y2={y(p)} stroke="currentColor" className="text-line" strokeWidth={0.5} /><text x={2} y={y(p) + 3} fontSize={9} className="fill-muted">{p}%</text></g>)}
            <line x1={P} x2={W - 8} y1={y(warn)} y2={y(warn)} stroke="#e66767" strokeDasharray="4 3" strokeWidth={0.8} />
            {buckets.map((b, i) => {
                const pts = history.filter((h) => h.bucket === b && h.limit).map((h) => `${x(h.ts).toFixed(1)},${y((h.remaining / h.limit) * 100).toFixed(1)}`)
                return <polyline key={b} points={pts.join(' ')} fill="none" stroke={SLOT[i % SLOT.length]} strokeWidth={1.5} />
            })}
            {buckets.map((b, i) => <g key={b}><rect x={P + i * 90} y={H - 11} width={8} height={8} fill={SLOT[i % SLOT.length]} /><text x={P + i * 90 + 11} y={H - 4} fontSize={9} className="fill-dim">{b}</text></g>)}
        </svg>
    )
}

export function GithubUsage() {
    const [hours, setHours] = useState(48)
    const utils = api.useUtils()
    const s = api.ops.gh.state.useQuery({ hours }, { refetchInterval: 60_000 })
    const calls = api.ops.gh.calls.useQuery({ limit: 60 })
    const sample = api.ops.gh.sample.useMutation({ onSuccess: () => { utils.ops.gh.invalidate() } })
    return (
        <Page title="Usage" tabs={USAGE_TABS} hint="GitHub API budget: every gh call goes through the rate-limit wrapper, which logs it and backs off when a bucket runs low."
            actions={<>
                {RANGES.map(([l, h]) => <button key={l} className={`btn ${hours === h ? 'bg-hover text-sky-300' : ''}`} onClick={() => setHours(h)}>{l}</button>)}
                <button className="btn" disabled={sample.isPending} onClick={() => sample.mutate()}>{sample.isPending ? 'Sampling...' : 'Sample now'}</button>
            </>}>
            <Err e={s.error ?? sample.error ?? calls.error} />
            {s.data?.low.length ? <div className="mb-3 rounded border border-red-400/40 bg-red-400/10 p-2 text-[12px] text-red-300">Low GitHub API budget: {s.data.low.map((b) => `${b.bucket} ${b.remaining}/${b.limit} (${b.pct}%)`).join(', ')}. Non-essential calls are skipped until it resets.</div> : null}
            {s.data && s.data.buckets.length === 0 && <Empty>No rate-limit samples yet. gh may be unauthenticated here; press Sample now once it is.</Empty>}
            <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
                {s.data?.buckets.map((b) => (
                    <div key={b.bucket} className="rounded-lg border border-line bg-panel/40 p-3">
                        <div className="text-[11px] text-muted">{b.bucket}</div>
                        <div className={`text-[20px] font-semibold tabular-nums ${b.pct <= (s.data?.warnPct ?? 20) ? 'text-red-300' : ''}`}>{b.remaining}<span className="text-[12px] font-normal text-muted"> / {b.limit}</span></div>
                        <div className="mt-1 h-1 rounded bg-hover"><div className="h-1 rounded bg-accent" style={{ width: `${b.pct}%` }} /></div>
                        <div className="mt-1 text-[11px] text-muted">resets {b.reset ? new Date(b.reset).toISOString().slice(11, 16) + ' UTC' : '-'} · sampled {ago(b.at)}</div>
                    </div>
                ))}
            </div>
            {s.data && <div className="mb-5"><Chart history={s.data.history} warn={s.data.warnPct} /><div className="mt-1 text-[11px] text-muted">Remaining budget per bucket. Dashed line is the warning threshold ({s.data.warnPct}%, setting <code>ghWarnPct</code>).</div></div>}

            <h2 className="mb-1 text-[12px] font-medium text-dim">Callers</h2>
            {s.data && s.data.callers.length === 0 && <Empty>No gh calls in this range.</Empty>}
            {!!s.data?.callers.length && (
                <table className="mb-5 w-full text-[12px]">
                    <thead className="text-muted"><tr><TH>Caller</TH><TH>Bucket</TH><TH right>Calls</TH><TH right>Rate-limited</TH><TH right>Skipped</TH><TH right>Waited</TH></tr></thead>
                    <tbody>{s.data.callers.map((c) => (
                        <tr key={c.caller + c.bucket} className="border-t border-line hover:bg-hover/40"><td className="px-2 py-1.5 font-mono">{c.caller}</td><td className="px-2 py-1.5 text-dim">{c.bucket}</td>
                            <td className="px-2 py-1.5 text-right tabular-nums">{c.calls}</td><td className="px-2 py-1.5 text-right tabular-nums">{c.limited}</td><td className="px-2 py-1.5 text-right tabular-nums">{c.skipped}</td><td className="px-2 py-1.5 text-right tabular-nums">{(c.waitedMs / 1000).toFixed(1)}s</td></tr>))}</tbody>
                </table>
            )}
            <h2 className="mb-1 text-[12px] font-medium text-dim">Recent calls</h2>
            {!!calls.data?.length && (
                <table className="w-full text-[12px]">
                    <thead className="text-muted"><tr><TH>When</TH><TH>Caller</TH><TH>Command</TH><TH>Bucket</TH><TH right>Status</TH><TH right>ms</TH><TH>Flags</TH></tr></thead>
                    <tbody>{calls.data.map((c) => (
                        <tr key={c.id} className="border-t border-line hover:bg-hover/40"><td className="px-2 py-1.5 text-dim">{ago(c.ts)}</td><td className="px-2 py-1.5 font-mono">{c.caller}</td><td className="max-w-xs truncate px-2 py-1.5 font-mono text-dim" title={c.cmd}>{c.cmd}</td>
                            <td className="px-2 py-1.5 text-dim">{c.bucket}</td><td className="px-2 py-1.5 text-right tabular-nums">{c.status}</td><td className="px-2 py-1.5 text-right tabular-nums">{c.ms}</td>
                            <td className="px-2 py-1.5 text-amber-300">{c.limited ? 'rate-limited ' : ''}{c.skipped ? 'skipped' : ''}</td></tr>))}</tbody>
                </table>
            )}
        </Page>
    )
}
