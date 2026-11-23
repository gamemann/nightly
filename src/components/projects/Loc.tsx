'use client'
import { useState } from 'react'
import { can } from '../../../lib/permissions.mjs'
import { compact } from '../../../lib/loc-core.mjs'
import { Card, ErrorLine } from '~/components/shell/form'
import { api } from '~/trpc/react'

// Lines-of-code widgets: the badge on cards and folders, and the stat block on the project overview. Every number is
// compact (1.2k, 3.4M) with the exact value in a title tooltip.

type Totals = { code: number; comments: number; blanks: number; total: number; files: number }
const exact = (n: number) => n.toLocaleString('en-US')
const tip = (s: Totals) => `${exact(s.code)} code, ${exact(s.comments)} comments, ${exact(s.blanks)} blank, ${exact(s.total)} lines in ${exact(s.files)} files`

/** "12.3k LOC" chip; renders nothing when the project was never scanned. */
export function LocBadge({ s, label = 'LOC' }: { s?: Totals | null; label?: string }) {
    if (!s) return null
    return <span title={tip(s)} className="shrink-0 rounded border border-line px-1.5 py-px text-[10.5px] tabular-nums text-dim">{compact(s.code)} {label}</span>
}

/** One-axis line + area sparkline of code lines over time; a dashed placeholder until there are two points. */
export function Sparkline({ points }: { points: { at: string | Date; code: number }[] }) {
    const W = 320, H = 56, P = 4
    if (points.length < 2) return <p className="rounded border border-dashed border-line px-3 py-3 text-[12px] text-muted">History starts after the second scan.</p>
    const xs = points.map((p) => new Date(p.at).getTime())
    const ys = points.map((p) => p.code)
    const x0 = xs[0]!, x1 = xs[xs.length - 1]!
    const lo = Math.min(...ys), hi = Math.max(...ys)
    const px = (t: number) => P + (x1 === x0 ? 0 : ((t - x0) / (x1 - x0)) * (W - 2 * P))
    const py = (v: number) => H - P - (hi === lo ? 0.5 : (v - lo) / (hi - lo)) * (H - 2 * P)
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${px(xs[i]!).toFixed(1)},${py(p.code).toFixed(1)}`).join(' ')
    const last = points[points.length - 1]!
    return (
        <figure className="m-0">
            <svg viewBox={`0 0 ${W} ${H}`} className="h-14 w-full" role="img" aria-label={`Code lines from ${compact(points[0]!.code)} to ${compact(last.code)}`}>
                <path d={`${line} L${px(x1).toFixed(1)},${H - P} L${px(x0).toFixed(1)},${H - P} Z`} fill="#8b8cf8" fillOpacity="0.12" />
                <path d={line} fill="none" stroke="#8b8cf8" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
                <circle cx={px(x1)} cy={py(last.code)} r="4" fill="#8b8cf8" stroke="#0c1020" strokeWidth="2" />
                {points.map((p, i) => <circle key={i} cx={px(xs[i]!)} cy={py(p.code)} r="7" fill="transparent"><title>{`${new Date(p.at).toISOString().slice(0, 10)}: ${exact(p.code)} code lines`}</title></circle>)}
            </svg>
            <figcaption className="flex justify-between text-[11px] text-muted"><span>{new Date(x0).toISOString().slice(0, 10)} · {compact(lo)}-{compact(hi)}</span><span>{points.length} points</span></figcaption>
        </figure>
    )
}

/** Horizontal bars, one hue, labelled directly: the top languages by code lines and a folded "Other". */
function Languages({ langs }: { langs: { name: string; code: number; files: number }[] }) {
    const sorted = [...langs].sort((a, b) => b.code - a.code)
    const top = sorted.slice(0, 8)
    const rest = sorted.slice(8)
    if (rest.length) top.push({ name: `Other (${rest.length})`, code: rest.reduce((n, l) => n + l.code, 0), files: rest.reduce((n, l) => n + l.files, 0) })
    const max = Math.max(1, ...top.map((l) => l.code))
    return (
        <ul className="m-0 list-none space-y-1.5 p-0">
            {top.map((l) => (
                <li key={l.name} title={`${exact(l.code)} code lines in ${exact(l.files)} files`} className="grid grid-cols-[7.5rem_1fr_3.5rem] items-center gap-2 text-[12px]">
                    <span className="truncate text-dim">{l.name}</span>
                    <span className="h-2 rounded-sm bg-line/50"><span className="block h-2 rounded-r bg-accent" style={{ width: `${Math.max(2, (l.code / max) * 100)}%` }} /></span>
                    <span className="text-right tabular-nums text-muted">{compact(l.code)}</span>
                </li>
            ))}
        </ul>
    )
}

function Stat({ label, v, full }: { label: string; v: number; full: string }) {
    return <div title={full}><div className="text-[11px] uppercase tracking-wide text-muted">{label}</div><div className="text-[18px] font-semibold tabular-nums">{compact(v)}</div></div>
}

/** The project overview block: totals, language bars, history sparkline and a rescan button for editors. */
export function LocStatBlock({ slug }: { slug: string }) {
    const utils = api.useUtils()
    const me = api.account.me.useQuery()
    const q = api.loc.project.useQuery({ slug })
    const [force, setForce] = useState(false)
    const rescan = api.loc.rescan.useMutation({ onSuccess: () => { void utils.loc.invalidate() } })
    const d = q.data?.latest
    return (
        <Card title="Lines of code" actions={can(me.data?.perms, 'projects.edit') && (
            <span className="flex items-center gap-2">
                <label className="flex items-center gap-1 text-[11px] text-muted"><input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} /> force</label>
                <button className="btn" disabled={rescan.isPending} onClick={() => rescan.mutate({ slug, force })}>{rescan.isPending ? 'Scanning...' : 'Rescan'}</button>
            </span>
        )}>
            <ErrorLine error={q.error ?? rescan.error} />
            {rescan.data?.failed.length ? <p className="mb-2 text-[12px] text-red-400">{rescan.data.failed.join('; ')}</p> : null}
            {rescan.data?.chError ? <p className="mb-2 text-[12px] text-muted">History store unreachable ({rescan.data.chError}); the cache still updated.</p> : null}
            {!q.data ? null : !d ? <p className="text-[13px] text-dim">Not scanned yet. {can(me.data?.perms, 'projects.edit') ? 'Press Rescan, or run nightly loc.' : ''}</p> : (
                <div className="space-y-4">
                    <div className="flex flex-wrap gap-x-8 gap-y-2">
                        <Stat label="Code" v={d.code} full={`${exact(d.code)} code lines`} />
                        <Stat label="Comments" v={d.comments} full={`${exact(d.comments)} comment lines`} />
                        <Stat label="Blank" v={d.blanks} full={`${exact(d.blanks)} blank lines`} />
                        <Stat label="Total" v={d.total} full={`${exact(d.total)} lines`} />
                        <Stat label="Files" v={d.files} full={`${exact(d.files)} files`} />
                    </div>
                    <div className="grid gap-5 md:grid-cols-2">
                        <div><h4 className="mb-1.5 text-[12px] font-medium text-dim">Languages</h4><Languages langs={d.byLanguage} /></div>
                        <div><h4 className="mb-1.5 text-[12px] font-medium text-dim">Code lines over time</h4><Sparkline points={q.data.history} /></div>
                    </div>
                    <p className="text-[11px] text-muted">Scanned {new Date(d.scannedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC at {d.sha.slice(0, 8) || 'no commit'}</p>
                </div>
            )}
        </Card>
    )
}
