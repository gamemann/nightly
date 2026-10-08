'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api, type RouterOutputs } from '~/trpc/react'
import { useDebounced } from './ItemList'
import { StatusPill, ago } from './pills'

type Schedule = RouterOutputs['schedule']['list'][number]

const when = (d: Date | string) =>
    new Date(d).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })

const EXAMPLES = [
    ['0 7 * * *', 'every day 07:00'],
    ['0 13 * * 1-5', 'weekdays 13:00'],
    ['30 2 * * 0', 'Sundays 02:30'],
    ['0 */6 * * *', 'every 6 hours'],
]

export function Schedules() {
    const utils = api.useUtils()
    const router = useRouter()
    const list = api.schedule.list.useQuery(undefined, { refetchInterval: 30_000 })
    const settings = api.setting.all.useQuery()
    const running = api.schedule.running.useQuery(undefined, { refetchInterval: 10_000 })
    const setSetting = api.setting.set.useMutation({ onSuccess: () => utils.setting.all.invalidate() })
    const create = api.schedule.create.useMutation({ onSuccess: () => utils.schedule.list.invalidate() })
    const doRun = settings.data?.doRun === 'true'
    return (
        <div className="mx-auto max-w-4xl px-6 py-5 max-md:px-3">
            <div className="mb-3 flex items-end justify-between gap-4">
                <div>
                    <h1 className="text-[15px] font-semibold tracking-tight">Schedules</h1>
                    <p className="mt-0.5 text-[12px] text-muted">
                        When the runner starts, and with what instructions. The panel checks every minute and starts what is due.
                    </p>
                </div>
                <button className="btn-primary shrink-0" disabled={create.isPending}
                    onClick={() => create.mutate({ name: 'New schedule', cron: '0 13 * * *', enabled: false })}>+ New schedule</button>
            </div>

            <div className="mb-4 flex items-center justify-between gap-6 rounded-lg border border-line bg-panel/60 px-4 py-3">
                <div>
                    <div className="font-medium">{doRun ? 'Schedules are live' : 'All schedules paused'}</div>
                    <p className="mt-0.5 text-[12px] text-muted">The master switch (Settings → Nightly run). Paused, a due schedule is skipped quietly; Run now still works.</p>
                </div>
                <button role="switch" aria-checked={doRun} disabled={!settings.data || setSetting.isPending}
                    onClick={() => setSetting.mutate({ key: 'doRun', value: doRun ? 'false' : 'true' })}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${doRun ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                    <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${doRun ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
            </div>

            <SchedulerHealth lastTickAt={settings.data?.lastTickAt} lastTickBy={settings.data?.lastTickBy} />

            {!!running.data?.length && (
                <div className="mb-4 rounded-lg border border-amber-400/25 bg-amber-400/5 px-4 py-2.5 text-[12px]">
                    {running.data.map((r) => (
                        <Link key={r.id} href={`/runs/${r.id}`} className="flex items-center gap-2 py-0.5 text-amber-200 hover:text-amber-100">
                            <span className="size-1.5 animate-pulse rounded-full bg-amber-400" />
                            Run #{r.id} {r.schedule ? `(${r.schedule.name})` : ''} running for {ago(r.startedAt).replace(' ago', '')} →
                        </Link>
                    ))}
                </div>
            )}

            {list.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
            {list.data?.length === 0 && <div className="rounded-lg border border-line p-10 text-center text-muted">No schedules. Nothing starts on its own.</div>}
            <div className="space-y-3">
                {list.data?.map((s) => <ScheduleCard key={s.id} s={s} paused={!doRun} onStarted={(id) => router.push(`/runs/${id}`)} />)}
            </div>
        </div>
    )
}

function ScheduleCard({ s, paused, onStarted }: { s: Schedule; paused: boolean; onStarted: (runId: number) => void }) {
    const utils = api.useUtils()
    const invalidate = () => Promise.all([utils.schedule.list.invalidate(), utils.schedule.running.invalidate(), utils.run.list.invalidate()])
    const update = api.schedule.update.useMutation({ onSuccess: invalidate })
    const del = api.schedule.delete.useMutation({ onSuccess: invalidate })
    const start = api.schedule.start.useMutation({
        onSuccess: async (r) => { await invalidate(); if (r.status === 'skipped') alert(`Run #${r.id} was skipped: another run is still going and this schedule does not allow overlap.`); else onStarted(r.id) },
    })
    const prompts = api.schedule.prompts.useQuery()
    const [open, setOpen] = useState(false)
    const [cron, setCron] = useState(s.cron)
    useEffect(() => setCron(s.cron), [s.cron])
    const dcron = useDebounced(cron, 300)
    const preview = api.schedule.preview.useQuery({ cron: dcron }, { enabled: dcron !== s.cron, placeholderData: (p) => p })
    const shown = dcron === s.cron ? { error: s.error, next: s.next } : preview.data ?? { error: null, next: [] }
    const save = (patch: Parameters<typeof update.mutate>[0]['patch']) => update.mutate({ id: s.id, patch })
    const err = update.error?.data?.zodError?.fieldErrors ?? {}

    return (
        <div className={`rounded-lg border bg-panel/40 ${s.enabled ? 'border-line' : 'border-line/60 opacity-80'}`}>
            <div className="flex items-center gap-3 px-4 py-3 max-md:flex-wrap">
                <button role="switch" aria-checked={s.enabled} title={s.enabled ? 'Enabled' : 'Disabled'} onClick={() => save({ enabled: !s.enabled })}
                    className={`relative h-5 w-9 shrink-0 rounded-full transition ${s.enabled ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                    <span className={`absolute top-0.5 size-4 rounded-full bg-white shadow transition-all ${s.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                </button>
                <input defaultValue={s.name} key={s.name} onBlur={(e) => e.target.value.trim() && e.target.value !== s.name && save({ name: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                    className="min-w-0 flex-1 rounded bg-transparent px-1 py-0.5 text-[14px] font-medium outline-none hover:bg-hover focus:bg-panel-2" />
                <code className="rounded border border-line bg-panel-2 px-1.5 py-0.5 font-mono text-[11.5px] text-dim">{s.cron}</code>
                <span className="w-44 shrink-0 text-right text-[11.5px] text-muted max-md:w-auto">
                    {s.error ? <span className="text-red-300">invalid</span>
                        : !s.enabled ? 'disabled' : paused ? 'paused' : s.next[0] ? `next ${when(s.next[0])}` : 'never fires'}
                </span>
                <button className="btn" disabled={start.isPending} onClick={() => start.mutate({ id: s.id })} title="Start this schedule now (ignores the pause switch)">▶ Run now</button>
                <button className="icon-btn" onClick={() => setOpen(!open)} title="Edit">{open ? '▴' : '▾'}</button>
            </div>
            {start.error && <p className="px-4 pb-2 text-[12px] text-red-300">{start.error.message}</p>}
            {s.lastRun && !open && (
                <Link href={`/runs/${s.lastRun.id}`} className="flex items-center gap-2 border-t border-line/60 px-4 py-2 text-[12px] text-muted hover:bg-hover/40">
                    last <StatusPill status={s.lastRun.status} /> {ago(s.lastRun.startedAt)}
                    <span className="min-w-0 flex-1 truncate text-dim">{s.lastRun.summary}</span>
                </Link>
            )}
            {open && (
                <div className="grid gap-4 border-t border-line/60 px-4 py-4 text-[12px]">
                    <label className="grid gap-1">
                        <span className="label">When (cron: minute hour day month weekday, local time)</span>
                        <div className="flex flex-wrap items-center gap-2">
                            <input value={cron} onChange={(e) => setCron(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                                onBlur={() => cron.trim() !== s.cron && !shown.error && save({ cron: cron.trim() })}
                                className="input w-48 font-mono" spellCheck={false} />
                            {EXAMPLES.map(([c, l]) => (
                                <button key={c} type="button" className="btn" onClick={() => { setCron(c); save({ cron: c }) }}>{l}</button>
                            ))}
                        </div>
                        <span className={shown.error ? 'text-red-300' : 'text-muted'}>
                            {shown.error ?? (shown.next.length ? `Next: ${shown.next.map(when).join(' · ')}` : 'Never fires within a year.')}
                        </span>
                        {err.cron && <span className="text-red-300">{err.cron.join(' ')}</span>}
                    </label>
                    <div className="flex flex-wrap gap-6">
                        <label className="grid gap-1">
                            <span className="label">Prompt</span>
                            <select className="select" value={s.prompt} onChange={(e) => save({ prompt: e.target.value })}>
                                {[...new Set([s.prompt, ...(prompts.data ?? [])])].map((p) => <option key={p} value={p}>{p}</option>)}
                            </select>
                        </label>
                        <label className="grid gap-1">
                            <span className="label">Max turns</span>
                            <input type="number" min={1} max={5000} defaultValue={s.maxTurns} key={s.maxTurns} className="input w-24"
                                onBlur={(e) => { const n = Math.round(Number(e.target.value)); if (n >= 1 && n !== s.maxTurns) save({ maxTurns: n }) }} />
                        </label>
                        <label className="flex items-center gap-2 self-end pb-1.5">
                            <input type="checkbox" checked={s.allowOverlap} onChange={(e) => save({ allowOverlap: e.target.checked })} />
                            <span className="text-dim">May run alongside another run</span>
                        </label>
                    </div>
                    <label className="grid gap-1">
                        <span className="label">Instructions for this schedule</span>
                        <textarea defaultValue={s.instructions} key={s.instructions} rows={5} className="input md-editor font-mono text-[12px]"
                            placeholder={'Appended to the prompt for these runs only, e.g.\nOnly the due checks tonight; leave the queue alone.\nOnly items with repos in game-dev/godot.'}
                            onBlur={(e) => e.target.value !== s.instructions && save({ instructions: e.target.value })} />
                        <span className="text-muted">Empty = the prompt as it is. This is how a schedule gets a task of its own.</span>
                    </label>
                    <div className="flex items-center justify-between gap-3 text-muted">
                        <span>
                            {s.lastFiredAt ? `Last fired ${ago(s.lastFiredAt)}` : 'Never fired'}
                            {update.isPending && ' · saving…'}
                        </span>
                        <button className="btn hover:!border-red-400/40 hover:!text-red-300" disabled={del.isPending}
                            onClick={() => confirm(`Delete schedule "${s.name}"? Its past runs stay.`) && del.mutate({ id: s.id })}>Delete</button>
                    </div>
                </div>
            )}
        </div>
    )
}

/** Whether anything is calling `nightly tick`: the panel's built-in scheduler or a crontab line. */
function SchedulerHealth({ lastTickAt, lastTickBy }: { lastTickAt?: string; lastTickBy?: string }) {
    const [, setNow] = useState(0)
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(t) }, [])
    const age = lastTickAt ? (Date.now() - Date.parse(lastTickAt)) / 60_000 : Infinity
    const by = lastTickBy === 'panel' ? 'the panel' : lastTickBy === 'cron' ? 'cron' : lastTickBy
    if (age < 3) {
        return <p className="mb-4 -mt-2 px-1 text-[11.5px] text-muted"><span className="mr-1.5 inline-block size-1.5 rounded-full bg-emerald-400 align-middle" />Scheduler checked {ago(lastTickAt)} ({by}).</p>
    }
    return (
        <div className="mb-4 rounded-lg border border-amber-400/30 bg-amber-400/5 px-4 py-2.5 text-[12px] text-amber-200">
            {lastTickAt ? `No scheduler has checked in since ${ago(lastTickAt)}` : 'No scheduler has checked in yet'}: schedules will not start on their own.
            The panel checks every minute while it runs (unless <code className="font-mono">NIGHTLY_SCHEDULER=off</code>); restart it, or add the crontab line from the README.
        </div>
    )
}
