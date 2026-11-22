'use client'
import { Suspense, type ReactNode } from 'react'
import { api, type RouterOutputs } from '~/trpc/react'
import { FEED_SPECS, type FeedName } from '~/lib/feedSpecs'
import { parsePage, type Paged } from '~/lib/paging'
import { DataTable, type Column } from './DataTable'
import { useUrlParams } from './Pagination'
import { ago } from './pills'

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
function ReleasesInner() {
    const q = useFeed('releases')
    const d = api.feed.releases.useQuery(input(q), { placeholderData: keep })
    return (
        <Shell title="Releases & deploys" hint="Version, CI state, where it is deployed and the rollback target. nightly releases add|deploy|list">
            <DataTable cols={RELEASE_COLS} data={d.data?.page ?? empty()} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search repo, version, changelog" empty={none('releases')}
                filters={[{ key: 'game', label: 'Game', options: opts(d.data?.facets.game) }, { key: 'channel', label: 'Channel', options: opts(d.data?.facets.channel) }, { key: 'ci', label: 'CI', options: opts(d.data?.facets.ci) }]} />
        </Shell>
    )
}

type Crash = RouterOutputs['feed']['crashes']['page']['rows'][number]
function CrashesInner() {
    const q = useFeed('crashes')
    const d = api.feed.crashes.useQuery(input(q), { placeholderData: keep })
    const utils = api.useUtils()
    const set = api.feed.setCrash.useMutation({ onSuccess: () => utils.feed.crashes.invalidate() })
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
    ]
    return (
        <Shell title="Health & crashes" hint="Crashes grouped by signature; a fixed group reopens when it recurs. nightly crash add|list|set">
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
function WebInner() {
    const q = useFeed('web')
    const d = api.feed.web.useQuery(input(q), { placeholderData: keep })
    return (
        <Shell title="Web checks" hint="Bundle size, web vitals and uptime as budgeted series; a sample over its budget opens an RSI finding. nightly web add|budget|list">
            <DataTable cols={WEB_COLS} data={d.data?.page ?? empty()} rowKey={(r) => r.key} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search game or metric" empty={none('web samples')}
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
function PlaytestsInner() {
    const q = useFeed('playtests')
    const d = api.feed.playtests.useQuery(input(q), { placeholderData: keep })
    return (
        <Shell title="Playtests & feedback" hint="Tester notes per build with a 1-5 rating and tags. nightly playtest add|list|summary">
            <DataTable cols={PLAY_COLS} data={d.data?.page ?? empty()} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search feedback, tags, build, tester" empty={none('playtests')}
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
function ContentInner() {
    const q = useFeed('content')
    const d = api.feed.content.useQuery(input(q), { placeholderData: keep })
    return (
        <Shell title="Content & balance" hint="Balance numbers per item; a value outside its [min, max] band opens an RSI finding. nightly content add|list|summary">
            <DataTable cols={CONTENT_COLS} data={d.data?.page ?? empty()} rowKey={(r) => r.id} sort={q.sort} dir={q.dir} q={q.q} active={q.f} searchHint="Search name, metric, category" empty={none('content stats')}
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
