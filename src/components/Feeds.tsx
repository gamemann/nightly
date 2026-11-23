'use client'
import { Suspense, useState, type ReactNode } from 'react'
import { api, type RouterOutputs } from '~/trpc/react'
import { FEED_SPECS, type FeedName } from '~/lib/feedSpecs'
import { parsePage, type Paged } from '~/lib/paging'
import { DataTable, type Column } from './DataTable'
import { useUrlParams } from './Pagination'
import { ago } from './pills'
import { FeedForm, field as fieldCls, type FieldDef } from './FeedEdit'

// The DB-driven health pages (releases, crashes, web budgets, playtests, content stats): one shell, one shared DataTable each.
// Search, sort, facet filters and paging are server-side and live in the URL.
const TONE: Record<string, string> = { passing: 'text-emerald-300', failing: 'text-red-300', pending: 'text-amber-300', open: 'text-red-300', fixed: 'text-emerald-300', ignored: 'text-zinc-400' }
const Tone = ({ v }: { v: string }) => <span className={TONE[v] ?? 'text-dim'}>{v}</span>
const none = (what: string) => `No ${what} match. Post some with the CLI or the ingest API (see the README).`

function Shell({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
    return (
        <div className="mx-auto max-w-6xl p-6">
            <h1 className="mb-1 text-lg font-semibold">{title}</h1>
            <p className="mb-4 text-[12px] text-dim">{hint}</p>
            {children}
        </div>
    )
}
const opts = (xs?: string[]) => (xs ?? []).map((value) => ({ value }))
const input = (q: ReturnType<typeof parsePage>) => ({ page: q.page, size: q.size, sort: q.sort, dir: q.dir, q: q.q || undefined, f: q.f })
const keep = <T,>(p: T) => p

type Kind = 'crash' | 'playtest' | 'content' | 'web'
type Editing = { id: number | null; initial: Record<string, string> }
/** Add / edit / delete state for one page; every write is the CLI's `nightly <kind> add|edit|delete` through the feed router. */
function useRowEditor(kind: Kind, refresh: () => void) {
    const [ed, setEd] = useState<Editing | null>(null)
    const [err, setErr] = useState('')
    const ok = () => { refresh(); setEd(null); setErr('') }
    const onError = (e: { message: string }) => setErr(e.message)
    const add = api.feed.feedAdd.useMutation({ onSuccess: ok, onError })
    const edit = api.feed.feedEdit.useMutation({ onSuccess: ok, onError })
    const del = api.feed.feedRemove.useMutation({ onSuccess: ok, onError })
    return {
        ed, err, busy: add.isPending || edit.isPending || del.isPending,
        open: (id: number | null, initial: Record<string, string>) => { setErr(''); setEd({ id, initial }) },
        close: () => setEd(null),
        save: (rec: Record<string, string>) => (ed?.id == null ? add.mutate({ kind, rec }) : edit.mutate({ kind, id: ed.id, rec })),
        remove: () => { if (ed?.id != null) del.mutate({ kind, id: ed.id }) },
    }
}
function RowForm({ e, fields }: { e: ReturnType<typeof useRowEditor>; fields: FieldDef[] }) {
    if (!e.ed) return null
    return <FeedForm key={String(e.ed.id)} fields={fields} initial={e.ed.initial} isNew={e.ed.id == null} busy={e.busy} error={e.err} onSave={e.save} onDelete={e.remove} onCancel={e.close} />
}
const AddBtn = ({ label, onClick }: { label: string; onClick: () => void }) => <div className="mb-3"><button className={fieldCls} onClick={onClick}>{label}</button></div>
const EditBtn = ({ onClick }: { onClick: () => void }) => <button className="text-[12px] text-accent hover:underline" onClick={onClick}>Edit</button>
const str = (o: Record<string, unknown>, ks: string[]) => Object.fromEntries(ks.map((k) => [k, o[k] == null ? '' : String(o[k])]))

function useFeed(name: FeedName) {
    const { sp } = useUrlParams()
    return parsePage(sp, FEED_SPECS[name])
}
const empty = (): Paged<never> => ({ rows: [], total: 0, page: 1, size: 100, pages: 1, from: 0, to: 0 })

type Rel = RouterOutputs['feed']['releases']['page']['rows'][number]
const RELEASE_COLS: Column<Rel>[] = [
    { key: 'repo', label: 'Repo', sortable: true, render: (r) => <span title={r.changelog}>{r.repo}</span> },
    { key: 'version', label: 'Version', sortable: true, className: 'font-mono', render: (r) => r.version },
    { key: 'channel', label: 'Channel', sortable: true, render: (r) => r.channel },
    { key: 'ci', label: 'CI', sortable: true, render: (r) => <Tone v={r.ci} /> },
    { key: 'deployedTo', label: 'Deployed to', sortable: true, render: (r) => r.deployedTo || '-' },
    { key: 'rollback', label: 'Rollback', className: 'font-mono', render: (r) => r.rollback || '-' },
    { key: 'at', label: 'When', sortable: true, className: 'text-dim', render: (r) => ago(r.at) },
]
type RelForm = { repo: string; version: string; channel: string; ci: string; changelog: string; rollback: string; deployedTo: string; isNew: boolean; env: string }
const BLANK: RelForm = { repo: '', version: '', channel: 'stable', ci: 'unknown', changelog: '', rollback: '', deployedTo: '', isNew: true, env: '' }
const field = 'rounded border border-line bg-panel px-2 py-1 text-[12px]'
function ReleasesInner() {
    const q = useFeed('releases')
    const d = api.feed.releases.useQuery(input(q), { placeholderData: keep })
    const utils = api.useUtils()
    const done = () => utils.feed.releases.invalidate()
    const [f, setF] = useState<RelForm | null>(null)
    const [msg, setMsg] = useState('')
    const fail = (e: { message: string }) => setMsg(e.message)
    const add = api.feed.releaseAdd.useMutation({ onSuccess: () => { done(); setF(null); setMsg('') }, onError: fail })
    const set = api.feed.releaseSet.useMutation({ onSuccess: () => { done(); setF(null); setMsg('') }, onError: fail })
    const deploy = api.feed.releaseDeploy.useMutation({ onSuccess: () => { done(); setF(null); setMsg('') }, onError: fail })
    const undeploy = api.feed.releaseUndeploy.useMutation({ onSuccess: () => { done(); setF(null); setMsg('') }, onError: fail })
    const remove = api.feed.releaseRemove.useMutation({ onSuccess: () => { done(); setF(null) }, onError: fail })
    const sync = api.feed.releasesSync.useMutation({ onSuccess: (o) => { done(); setMsg(`sync: ${o}`) }, onError: fail })
    const cols: Column<Rel>[] = [...RELEASE_COLS, { key: 'edit', label: '', render: (r) => (
        <button className="text-[12px] text-accent hover:underline" onClick={() => { setMsg(''); setF({ repo: r.repo, version: r.version, channel: r.channel, ci: r.ci, changelog: r.changelog, rollback: r.rollback, deployedTo: r.deployedTo, isNew: false, env: '' }) }}>Edit</button>
    ) }]
    const key = f ? { repo: f.repo, version: f.version, channel: f.channel || 'stable' } : null
    const up = (p: Partial<RelForm>) => setF((x) => (x ? { ...x, ...p } : x))
    return (
        <Shell title="Releases & deploys" hint="Version, CI state, where it is deployed and the rollback target. Tags are synced hourly (nightly releases sync); everything here is also nightly releases add|set|deploy|undeploy|rm|sync|list">
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <button className={field} onClick={() => { setMsg(''); setF({ ...BLANK }) }}>Add release</button>
                <button className={field} disabled={sync.isPending} onClick={() => sync.mutate()}>{sync.isPending ? 'Syncing...' : 'Sync now'}</button>
                {msg && <span className="text-[12px] text-dim">{msg}</span>}
            </div>
            {f && key && (
                <div className="mb-4 grid gap-2 rounded-lg border border-line p-3 text-[12px]">
                    <div className="flex flex-wrap gap-2">
                        <input className={field} placeholder="repo" value={f.repo} disabled={!f.isNew} onChange={(e) => up({ repo: e.target.value })} />
                        <input className={`${field} font-mono`} placeholder="version (v1.2.3)" value={f.version} disabled={!f.isNew} onChange={(e) => up({ version: e.target.value })} />
                        <input className={field} placeholder="channel" value={f.channel} disabled={!f.isNew} onChange={(e) => up({ channel: e.target.value })} />
                        <select className={field} value={f.ci} onChange={(e) => up({ ci: e.target.value })} aria-label="CI">{['unknown', 'pending', 'passing', 'failing'].map((c) => <option key={c}>{c}</option>)}</select>
                        <input className={`${field} font-mono`} placeholder="rollback version" value={f.rollback} onChange={(e) => up({ rollback: e.target.value })} />
                    </div>
                    <textarea className={`${field} min-h-[80px] font-mono`} placeholder="release notes" value={f.changelog} onChange={(e) => up({ changelog: e.target.value })} />
                    <div className="flex flex-wrap items-center gap-2">
                        {f.isNew
                            ? <input className={field} placeholder="deployed to (dev,prod)" value={f.deployedTo} onChange={(e) => up({ deployedTo: e.target.value })} />
                            : <>
                                <span className="text-dim">Deployed to: {f.deployedTo || '-'}</span>
                                <input className={field} placeholder="environment (prod)" value={f.env} onChange={(e) => up({ env: e.target.value })} />
                                <button className={field} disabled={!f.env} onClick={() => deploy.mutate({ ...key, to: f.env })}>Mark deployed</button>
                                <button className={field} disabled={!f.env} onClick={() => undeploy.mutate({ ...key, from: f.env })}>Remove env</button>
                            </>}
                        <span className="flex-1" />
                        <button className={field} disabled={!f.repo || !f.version} onClick={() => (f.isNew ? add.mutate({ ...key, ci: f.ci as 'unknown', changelog: f.changelog, rollback: f.rollback, deployedTo: f.deployedTo }) : set.mutate({ ...key, ci: f.ci as 'unknown', changelog: f.changelog, rollback: f.rollback }))}>{f.isNew ? 'Add' : 'Save'}</button>
                        {!f.isNew && <button className={`${field} text-red-300`} onClick={() => { if (confirm(`Delete ${f.repo} ${f.version}?`)) remove.mutate(key) }}>Delete</button>}
                        <button className={field} onClick={() => setF(null)}>Cancel</button>
                    </div>
                </div>
            )}
            <DataTable cols={cols} data={d.data?.page ?? empty()} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search repo, version, changelog" empty={none('releases')}
                filters={[{ key: 'game', label: 'Game', options: opts(d.data?.facets.game) }, { key: 'channel', label: 'Channel', options: opts(d.data?.facets.channel) }, { key: 'ci', label: 'CI', options: opts(d.data?.facets.ci) }]} />
        </Shell>
    )
}

const CRASH_FIELDS: FieldDef[] = [{ name: 'game', locked: true }, { name: 'signature', locked: true }, { name: 'version', locked: true }, { name: 'platform', locked: true }, { name: 'count' }, { name: 'status', options: ['open', 'fixed', 'ignored'] }, { name: 'sample', wide: true }]
type Crash = RouterOutputs['feed']['crashes']['page']['rows'][number]
function CrashesInner() {
    const q = useFeed('crashes')
    const d = api.feed.crashes.useQuery(input(q), { placeholderData: keep })
    const utils = api.useUtils()
    const set = api.feed.setCrash.useMutation({ onSuccess: () => utils.feed.crashes.invalidate() })
    const e = useRowEditor('crash', () => utils.feed.crashes.invalidate())
    const cols: Column<Crash>[] = [
        { key: 'game', label: 'Game', sortable: true, render: (r) => r.game },
        { key: 'signature', label: 'Signature', sortable: true, className: 'font-mono text-[12px]', render: (r) => <span title={r.sample}>{r.signature}</span> },
        { key: 'count', label: 'Count', sortable: true, className: 'tabular-nums', render: (r) => r.count },
        { key: 'version', label: 'Version', sortable: true, render: (r) => r.version || '-' },
        { key: 'platform', label: 'Platform', sortable: true, render: (r) => r.platform || '-' },
        { key: 'status', label: 'Status', sortable: true, render: (r) => (
            <select value={r.status} onChange={(e) => set.mutate({ game: r.game, signature: r.signature, status: e.target.value as 'open' | 'fixed' | 'ignored' })} className="rounded border border-line bg-panel px-1 text-[12px]"><option>open</option><option>fixed</option><option>ignored</option></select>
        ) },
        { key: 'at', label: 'Last seen', sortable: true, className: 'text-dim', render: (r) => ago(r.at) },
        { key: 'edit', label: '', render: (r) => <EditBtn onClick={() => e.open(r.id, str(r, ['game', 'signature', 'version', 'platform', 'count', 'status', 'sample']))} /> },
    ]
    return (
        <Shell title="Health & crashes" hint="Crashes grouped by signature; a fixed group reopens when it recurs. nightly crash add|list|edit|delete|set|scan|summary (scan runs hourly)">
            <AddBtn label="Add crash" onClick={() => e.open(null, { status: 'open' })} />
            <RowForm e={e} fields={CRASH_FIELDS} />
            <DataTable cols={cols} data={d.data?.page ?? empty()} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search signature, sample, game" empty={none('crashes')}
                filters={[{ key: 'game', label: 'Game', options: opts(d.data?.facets.game) }, { key: 'status', label: 'Status', options: opts(d.data?.facets.status) }, { key: 'platform', label: 'Platform', options: opts(d.data?.facets.platform) }]} />
        </Shell>
    )
}

type WebRow = RouterOutputs['feed']['web']['page']['rows'][number]
function Spark({ v, bad }: { v: number[]; bad: boolean }) {
    if (v.length < 2) return <span className="text-dim">-</span>
    const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1
    const pts = v.map((x, i) => `${(i / (v.length - 1)) * 100},${18 - ((x - lo) / span) * 16}`).join(' ')
    return <svg viewBox="0 0 100 20" className="h-5 w-24"><polyline points={pts} fill="none" stroke={bad ? '#fca5a5' : '#5eead4'} strokeWidth="1.5" /></svg>
}
const over = (r: WebRow) => r.latest != null && r.max != null && r.latest > r.max
const WEB_COLS: Column<WebRow>[] = [
    { key: 'key', label: 'Game / metric', sortable: true, render: (r) => r.key },
    { key: 'latest', label: 'Latest', sortable: true, className: 'tabular-nums', render: (r) => <span className={over(r) ? 'text-red-300' : ''}>{r.latest != null ? `${r.latest}${r.unit}` : '-'}</span> },
    { key: 'budget', label: 'Budget', sortable: true, className: 'tabular-nums text-dim', render: (r) => (r.max != null ? `<= ${r.max}${r.unit}` : 'none') },
    { key: 'trend', label: 'Trend', render: (r) => <Spark v={r.trend} bad={over(r)} /> },
    { key: 'at', label: 'When', sortable: true, className: 'text-dim', render: (r) => (r.at ? ago(r.at) : '-') },
]
const WEB_SAMPLE_FIELDS: FieldDef[] = [{ name: 'game' }, { name: 'metric' }, { name: 'value' }, { name: 'url' }]
const WEB_BUDGET_FIELDS: FieldDef[] = [{ name: 'game' }, { name: 'metric' }, { name: 'max' }, { name: 'unit' }]
function WebInner() {
    const q = useFeed('web')
    const d = api.feed.web.useQuery(input(q), { placeholderData: keep })
    const utils = api.useUtils()
    const [f, setF] = useState<{ budget: boolean; initial: Record<string, string> } | null>(null)
    const [err, setErr] = useState('')
    const done = () => { utils.feed.web.invalidate(); setF(null); setErr('') }
    const onError = (x: { message: string }) => setErr(x.message)
    const addSample = api.feed.feedAdd.useMutation({ onSuccess: done, onError })
    const setBudget = api.feed.setBudget.useMutation({ onSuccess: done, onError })
    const delBudget = api.feed.deleteBudget.useMutation({ onSuccess: done, onError })
    const cols: Column<WebRow>[] = [...WEB_COLS, { key: 'edit', label: '', render: (r) => <EditBtn onClick={() => { setErr(''); setF({ budget: true, initial: { game: r.game, metric: r.metric, max: r.max == null ? '' : String(r.max), unit: r.unit } }) }} /> }]
    return (
        <Shell title="Web checks" hint="Bundle size, web vitals and uptime as budgeted series; a sample over its budget opens an RSI finding. nightly webcheck add|budget|edit|delete|list|probe (probe runs every 15 minutes)">
            <div className="mb-3 flex gap-2">
                <button className={fieldCls} onClick={() => { setErr(''); setF({ budget: false, initial: {} }) }}>Add sample</button>
                <button className={fieldCls} onClick={() => { setErr(''); setF({ budget: true, initial: {} }) }}>Set budget</button>
            </div>
            {f && <FeedForm key={String(f.budget) + (f.initial.game ?? '') + (f.initial.metric ?? '')} fields={f.budget ? WEB_BUDGET_FIELDS : WEB_SAMPLE_FIELDS} initial={f.initial} isNew busy={addSample.isPending || setBudget.isPending || delBudget.isPending} error={err} onCancel={() => setF(null)}
                onSave={(v) => (f.budget ? setBudget.mutate({ game: v.game ?? '', metric: v.metric ?? '', max: Number(v.max), unit: v.unit ?? '' }) : addSample.mutate({ kind: 'web', rec: v }))} />}
            {f?.budget && f.initial.game && <div className="mb-3"><button className={`${fieldCls} text-red-300`} onClick={() => { if (confirm(`Delete the budget ${f.initial.game}/${f.initial.metric}?`)) delBudget.mutate({ game: f.initial.game, metric: f.initial.metric }) }}>Delete this budget</button></div>}
            <DataTable cols={cols} data={d.data?.page ?? empty()} rowKey={(r) => r.key} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search game or metric" empty={none('web samples')}
                filters={[{ key: 'game', label: 'Game', options: opts(d.data?.facets.game) }, { key: 'state', label: 'Budget', options: [{ value: 'over', label: 'over budget' }, { value: 'ok', label: 'within budget' }] }]} />
        </Shell>
    )
}

type Play = RouterOutputs['feed']['playtests']['page']['rows'][number]
const PLAY_COLS: Column<Play>[] = [
    { key: 'game', label: 'Game', sortable: true, render: (r) => r.game },
    { key: 'build', label: 'Build', sortable: true, className: 'font-mono', render: (r) => r.build || '-' },
    { key: 'tester', label: 'Tester', sortable: true, render: (r) => r.tester || '-' },
    { key: 'rating', label: 'Rating', sortable: true, className: 'tabular-nums', render: (r) => r.rating ?? '-' },
    { key: 'text', label: 'Feedback', render: (r) => <>{r.text}{r.tags && <span className="ml-2 text-[11px] text-dim">{r.tags}</span>}</> },
    { key: 'at', label: 'When', sortable: true, className: 'text-dim', render: (r) => ago(r.at) },
]
const PLAY_FIELDS: FieldDef[] = [{ name: 'game' }, { name: 'build' }, { name: 'tester' }, { name: 'rating' }, { name: 'tags' }, { name: 'text', wide: true }]
function PlaytestsInner() {
    const q = useFeed('playtests')
    const d = api.feed.playtests.useQuery(input(q), { placeholderData: keep })
    const utils = api.useUtils()
    const e = useRowEditor('playtest', () => utils.feed.playtests.invalidate())
    const cols: Column<Play>[] = [...PLAY_COLS, { key: 'edit', label: '', render: (r) => <EditBtn onClick={() => e.open(r.id, str(r, ['game', 'build', 'tester', 'rating', 'tags', 'text']))} /> }]
    return (
        <Shell title="Playtests & feedback" hint="Tester notes per build with a 1-5 rating and tags. nightly playtest add|list|edit|delete|summary|record|import-perf (bot runs: nightly playtest record, scheduled daily)">
            <AddBtn label="Add playtest" onClick={() => e.open(null, {})} />
            <RowForm e={e} fields={PLAY_FIELDS} />
            <DataTable cols={cols} data={d.data?.page ?? empty()} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search feedback, tags, build, tester" empty={none('playtests')}
                filters={[{ key: 'game', label: 'Game', options: opts(d.data?.facets.game) }, { key: 'tester', label: 'Tester', options: opts(d.data?.facets.tester) }]} />
        </Shell>
    )
}

type Stat = RouterOutputs['feed']['content']['page']['rows'][number]
const outside = (r: Stat) => (r.min != null && r.value < r.min) || (r.max != null && r.value > r.max)
const CONTENT_COLS: Column<Stat>[] = [
    { key: 'game', label: 'Game', sortable: true, render: (r) => r.game },
    { key: 'category', label: 'Category', sortable: true, render: (r) => r.category || '-' },
    { key: 'name', label: 'Name', sortable: true, render: (r) => r.name },
    { key: 'metric', label: 'Metric', sortable: true, render: (r) => r.metric },
    { key: 'value', label: 'Value', sortable: true, className: 'tabular-nums', render: (r) => <span className={outside(r) ? 'text-red-300' : ''}>{r.value}</span> },
    { key: 'band', label: 'Band', className: 'tabular-nums text-dim', render: (r) => `[${r.min ?? '-'}, ${r.max ?? '-'}]` },
]
const CONTENT_FIELDS: FieldDef[] = [{ name: 'game', locked: true }, { name: 'category', locked: true }, { name: 'name', locked: true }, { name: 'metric', locked: true }, { name: 'value' }, { name: 'min' }, { name: 'max' }]
function ContentInner() {
    const q = useFeed('content')
    const d = api.feed.content.useQuery(input(q), { placeholderData: keep })
    const utils = api.useUtils()
    const e = useRowEditor('content', () => utils.feed.content.invalidate())
    const cols: Column<Stat>[] = [...CONTENT_COLS, { key: 'edit', label: '', render: (r) => <EditBtn onClick={() => e.open(r.id, str(r, ['game', 'category', 'name', 'metric', 'value', 'min', 'max']))} /> }]
    return (
        <Shell title="Content & balance" hint="Balance numbers per item; a value outside its [min, max] band opens an RSI finding. nightly content add|list|edit|delete|summary|scan (scan runs daily)">
            <AddBtn label="Add stat" onClick={() => e.open(null, {})} />
            <RowForm e={e} fields={CONTENT_FIELDS} />
            <DataTable cols={cols} data={d.data?.page ?? empty()} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search name, metric, category" empty={none('content stats')}
                filters={[{ key: 'game', label: 'Game', options: opts(d.data?.facets.game) }, { key: 'category', label: 'Category', options: opts(d.data?.facets.category) }, { key: 'metric', label: 'Metric', options: opts(d.data?.facets.metric) }]} />
        </Shell>
    )
}

// useSearchParams needs a Suspense boundary on prerendered pages.
export const Releases = () => <Suspense><ReleasesInner /></Suspense>
export const Crashes = () => <Suspense><CrashesInner /></Suspense>
export const Web = () => <Suspense><WebInner /></Suspense>
export const Playtests = () => <Suspense><PlaytestsInner /></Suspense>
export const Content = () => <Suspense><ContentInner /></Suspense>
