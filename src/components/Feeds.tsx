'use client'
import { useState, type ReactNode } from 'react'
import { api } from '~/trpc/react'
import { ago } from './pills'

// One small, generic shell for the DB-driven health pages (releases, crashes, web budgets, playtests, content stats).
const th = 'px-2 py-1.5 text-left text-[11px] font-medium uppercase tracking-wide text-muted'
const td = 'px-2 py-1.5 align-top'
const TONE: Record<string, string> = { passing: 'text-emerald-300', failing: 'text-red-300', pending: 'text-amber-300', open: 'text-red-300', fixed: 'text-emerald-300', ignored: 'text-zinc-400' }

function Shell({ title, hint, filter, children }: { title: string; hint: string; filter: ReactNode; children: ReactNode }) {
    return (
        <div className="mx-auto max-w-6xl p-6">
            <div className="mb-1 flex items-center gap-3"><h1 className="text-lg font-semibold">{title}</h1><div className="ml-auto">{filter}</div></div>
            <p className="mb-4 text-[12px] text-dim">{hint}</p>
            <div className="overflow-x-auto rounded-lg border border-line">{children}</div>
        </div>
    )
}
const Empty = ({ cols, what }: { cols: number; what: string }) => <tr><td colSpan={cols} className="px-3 py-6 text-center text-dim">No {what} yet. Post some with the CLI or the ingest API (see the README).</td></tr>
const Tone = ({ v }: { v: string }) => <span className={TONE[v] ?? 'text-dim'}>{v}</span>
function useGame() {
    const [game, setGame] = useState('')
    const filter = <input value={game} onChange={(e) => setGame(e.target.value)} placeholder="filter by game" className="rounded border border-line bg-panel px-2 py-1 text-[12px]" />
    return { game: game || undefined, filter }
}

export function Releases() {
    const { game, filter } = useGame()
    const q = api.feed.releases.useQuery({ game })
    return (
        <Shell title="Releases & deploys" hint="Version, CI state, where it is deployed and the rollback target. nightly releases add|deploy|list" filter={filter}>
            <table className="w-full text-[13px]"><thead><tr><th className={th}>Repo</th><th className={th}>Version</th><th className={th}>Channel</th><th className={th}>CI</th><th className={th}>Deployed to</th><th className={th}>Rollback</th><th className={th}>When</th></tr></thead>
                <tbody>{q.data?.length ? q.data.map((r) => (
                    <tr key={r.id} className="border-t border-line" title={r.changelog}><td className={td}>{r.repo}</td><td className={`${td} font-mono`}>{r.version}</td><td className={td}>{r.channel}</td><td className={td}><Tone v={r.ci} /></td><td className={td}>{r.deployedTo || '-'}</td><td className={`${td} font-mono`}>{r.rollback || '-'}</td><td className={`${td} text-dim`}>{ago(r.at)}</td></tr>
                )) : <Empty cols={7} what="releases" />}</tbody></table>
        </Shell>
    )
}

export function Crashes() {
    const { game, filter } = useGame()
    const q = api.feed.crashes.useQuery({ game })
    const utils = api.useUtils()
    const set = api.feed.setCrash.useMutation({ onSuccess: () => utils.feed.crashes.invalidate() })
    return (
        <Shell title="Health & crashes" hint="Crashes grouped by signature; a fixed group reopens when it recurs. nightly crash add|list|set" filter={filter}>
            <table className="w-full text-[13px]"><thead><tr><th className={th}>Game</th><th className={th}>Signature</th><th className={th}>Count</th><th className={th}>Version</th><th className={th}>Platform</th><th className={th}>Status</th><th className={th}>Last seen</th></tr></thead>
                <tbody>{q.data?.length ? q.data.map((r) => (
                    <tr key={r.id} className="border-t border-line" title={r.sample}><td className={td}>{r.game}</td><td className={`${td} font-mono text-[12px]`}>{r.signature}</td><td className={`${td} tabular-nums`}>{r.count}</td><td className={td}>{r.version || '-'}</td><td className={td}>{r.platform || '-'}</td>
                        <td className={td}><select value={r.status} onChange={(e) => set.mutate({ game: r.game, signature: r.signature, status: e.target.value as 'open' | 'fixed' | 'ignored' })} className="rounded border border-line bg-panel px-1 text-[12px]"><option>open</option><option>fixed</option><option>ignored</option></select></td>
                        <td className={`${td} text-dim`}>{ago(r.at)}</td></tr>
                )) : <Empty cols={7} what="crashes" />}</tbody></table>
        </Shell>
    )
}

export function Web() {
    const { game, filter } = useGame()
    const budgets = api.feed.webBudgets.useQuery()
    const series = api.feed.webSeries.useQuery({ game })
    const latest = new Map<string, { value: number; at: Date }>()
    const hist = new Map<string, number[]>()
    for (const s of [...(series.data ?? [])].reverse()) { const k = `${s.game}/${s.metric}`; latest.set(k, { value: s.value, at: s.at }); hist.set(k, [...(hist.get(k) ?? []), s.value].slice(-30)) }
    const keys = [...new Set([...latest.keys(), ...(budgets.data ?? []).filter((b) => !game || b.game === game).map((b) => `${b.game}/${b.metric}`)])].sort()
    return (
        <Shell title="Web checks" hint="Bundle size, web vitals and uptime as budgeted series; a sample over its budget opens an RSI finding. nightly web add|budget|list" filter={filter}>
            <table className="w-full text-[13px]"><thead><tr><th className={th}>Game / metric</th><th className={th}>Latest</th><th className={th}>Budget</th><th className={th}>Trend</th><th className={th}>When</th></tr></thead>
                <tbody>{keys.length ? keys.map((k) => {
                    const l = latest.get(k); const b = budgets.data?.find((x) => `${x.game}/${x.metric}` === k); const over = l && b && l.value > b.max
                    return <tr key={k} className="border-t border-line"><td className={td}>{k}</td><td className={`${td} tabular-nums ${over ? 'text-red-300' : ''}`}>{l ? `${l.value}${b?.unit ?? ''}` : '-'}</td><td className={`${td} tabular-nums text-dim`}>{b ? `<= ${b.max}${b.unit}` : 'none'}</td><td className={td}><Spark v={hist.get(k) ?? []} bad={!!over} /></td><td className={`${td} text-dim`}>{l ? ago(l.at) : '-'}</td></tr>
                }) : <Empty cols={5} what="web samples" />}</tbody></table>
        </Shell>
    )
}
function Spark({ v, bad }: { v: number[]; bad: boolean }) {
    if (v.length < 2) return <span className="text-dim">-</span>
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1
    const pts = v.map((x, i) => `${(i / (v.length - 1)) * 100},${18 - ((x - lo) / span) * 16}`).join(' ')
    return <svg viewBox="0 0 100 20" className="h-5 w-24"><polyline points={pts} fill="none" stroke={bad ? '#fca5a5' : '#5eead4'} strokeWidth="1.5" /></svg>
}

export function Playtests() {
    const { game, filter } = useGame()
    const q = api.feed.playtests.useQuery({ game })
    return (
        <Shell title="Playtests & feedback" hint="Tester notes per build with a 1-5 rating and tags. nightly playtest add|list|summary" filter={filter}>
            <table className="w-full text-[13px]"><thead><tr><th className={th}>Game</th><th className={th}>Build</th><th className={th}>Tester</th><th className={th}>Rating</th><th className={th}>Feedback</th><th className={th}>When</th></tr></thead>
                <tbody>{q.data?.length ? q.data.map((r) => (
                    <tr key={r.id} className="border-t border-line"><td className={td}>{r.game}</td><td className={`${td} font-mono`}>{r.build || '-'}</td><td className={td}>{r.tester || '-'}</td><td className={`${td} tabular-nums`}>{r.rating ?? '-'}</td><td className={td}>{r.text}{r.tags && <span className="ml-2 text-[11px] text-dim">{r.tags}</span>}</td><td className={`${td} text-dim`}>{ago(r.at)}</td></tr>
                )) : <Empty cols={6} what="playtests" />}</tbody></table>
        </Shell>
    )
}

export function Content() {
    const { game, filter } = useGame()
    const q = api.feed.content.useQuery({ game })
    return (
        <Shell title="Content & balance" hint="Balance numbers per item; a value outside its [min, max] band opens an RSI finding. nightly content add|list|summary" filter={filter}>
            <table className="w-full text-[13px]"><thead><tr><th className={th}>Game</th><th className={th}>Category</th><th className={th}>Name</th><th className={th}>Metric</th><th className={th}>Value</th><th className={th}>Band</th></tr></thead>
                <tbody>{q.data?.length ? q.data.map((r) => {
                    const out = (r.min != null && r.value < r.min) || (r.max != null && r.value > r.max)
                    return <tr key={r.id} className="border-t border-line"><td className={td}>{r.game}</td><td className={td}>{r.category || '-'}</td><td className={td}>{r.name}</td><td className={td}>{r.metric}</td><td className={`${td} tabular-nums ${out ? 'text-red-300' : ''}`}>{r.value}</td><td className={`${td} tabular-nums text-dim`}>[{r.min ?? '-'}, {r.max ?? '-'}]</td></tr>
                }) : <Empty cols={6} what="content stats" />}</tbody></table>
        </Shell>
    )
}
