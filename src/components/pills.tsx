import { STATUS_LABEL } from '~/lib/constants'

const STATUS_STYLE: Record<string, string> = {
    queue: 'text-sky-300 bg-sky-400/10 ring-sky-400/20',
    in_progress: 'text-amber-300 bg-amber-400/10 ring-amber-400/25',
    review: 'text-violet-300 bg-violet-400/10 ring-violet-400/25',
    blocked: 'text-red-300 bg-red-400/10 ring-red-400/25',
    done: 'text-emerald-300 bg-emerald-400/10 ring-emerald-400/20',
    wontfix: 'text-zinc-400 bg-zinc-400/10 ring-zinc-400/20',
    running: 'text-amber-300 bg-amber-400/10 ring-amber-400/25',
    ok: 'text-emerald-300 bg-emerald-400/10 ring-emerald-400/20',
    failed: 'text-red-300 bg-red-400/10 ring-red-400/25',
    skipped: 'text-zinc-400 bg-zinc-400/10 ring-zinc-400/20',
}

export const STATUS_DOT: Record<string, string> = {
    queue: 'bg-sky-400', in_progress: 'bg-amber-400', review: 'bg-violet-400', blocked: 'bg-red-400', done: 'bg-emerald-400', wontfix: 'bg-zinc-500',
}

export function StatusPill({ status }: { status: string }) {
    return (
        <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-px text-[11px] font-medium ring-1 ring-inset ${STATUS_STYLE[status] ?? STATUS_STYLE.skipped}`}>
            {STATUS_LABEL[status] ?? status}
        </span>
    )
}

const KIND_STYLE: Record<string, string> = {
    task: 'text-dim', issue: 'text-rose-300', check: 'text-teal-300', study: 'text-yellow-200',
}
const KIND_ICON: Record<string, string> = { task: '◇', issue: '⚑', check: '↻', study: '✎' }

export function KindTag({ kind }: { kind: string }) {
    return (
        <span className={`inline-flex w-14 shrink-0 items-center gap-1 text-[11px] ${KIND_STYLE[kind] ?? 'text-dim'}`}>
            <span aria-hidden>{KIND_ICON[kind] ?? '·'}</span>{kind}
        </span>
    )
}

export function RepoChips({ repos, max = 3 }: { repos: string; max?: number }) {
    const list = repos.split(',').map((s) => s.trim()).filter(Boolean)
    if (!list.length) return null
    return (
        <span className="flex min-w-0 shrink items-center gap-1 overflow-hidden">
            {list.slice(0, max).map((r) => (
                <span key={r} className="truncate rounded border border-line bg-panel-2 px-1.5 py-px font-mono text-[10.5px] text-dim">{r}</span>
            ))}
            {list.length > max && <span className="text-[10.5px] text-muted">+{list.length - max}</span>}
        </span>
    )
}

export function ago(d: Date | string | null | undefined) {
    if (!d) return 'never'
    const s = (Date.now() - new Date(d).getTime()) / 1000
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)}m ago`
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`
    if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`
    return new Date(d).toISOString().slice(0, 10)
}

export const fmt = (d: Date | string | null | undefined) =>
    d ? new Date(d).toLocaleString('en-GB', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'
