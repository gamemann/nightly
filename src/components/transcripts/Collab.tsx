'use client'
import Link from 'next/link'
import { ago } from '~/components/pills'
import { short, tokens } from './types'

type Node = { id: number; parentId: number | null; agentId: string; agentType: string; description: string; title: string; status: string; startedAt: string; lastAt: string; messageCount: number; toolCount: number; outTokens: number; model: string; tools: Record<string, number> }

/** Who spawned whom: a tree of the session's threads with tool usage per thread, then a start-ordered timeline. */
export function Collab({ nodes, current }: { nodes: Node[]; current: number }) {
    const byParent = new Map<number | null, Node[]>()
    for (const n of nodes) byParent.set(n.parentId, [...(byParent.get(n.parentId) ?? []), n])
    const roots = nodes.filter((n) => !n.agentId)
    const t0 = Math.min(...nodes.map((n) => Date.parse(n.startedAt) || Infinity))
    const t1 = Math.max(...nodes.map((n) => Date.parse(n.lastAt) || 0), t0 + 1)
    const row = (n: Node, depth: number): React.ReactNode => (
        <div key={n.id}>
            <Link href={`/transcripts/${n.id}`} className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-[12px] hover:bg-hover ${n.id === current ? 'bg-hover' : ''}`} style={{ paddingLeft: 8 + depth * 18 }}>
                <span className="text-muted">{depth ? '↳' : '●'}</span>
                <span className="font-medium text-accent">{n.agentId ? n.agentType || 'agent' : 'main'}</span>
                <span className="min-w-0 flex-1 truncate text-dim">{short(n.description || n.title, 90)}</span>
                <span className="flex gap-1">{Object.entries(n.tools).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => <span key={k} className="rounded bg-panel-2 px-1 font-mono text-[10px] text-muted">{k} {v}</span>)}</span>
                <span className="w-24 text-right text-[11px] text-muted">{n.messageCount} msgs · {tokens(n.outTokens)}</span>
                <span className="w-14 text-right text-[11px] text-muted">{ago(n.lastAt)}</span>
            </Link>
            {(byParent.get(n.id) ?? []).map((k) => row(k, depth + 1))}
        </div>
    )
    return (
        <div className="mx-auto max-w-5xl space-y-6">
            <section>
                <div className="label mb-2">Tree</div>
                <div className="rounded-lg border border-line bg-panel p-1">{roots.map((r) => row(r, 0))}</div>
            </section>
            <section>
                <div className="label mb-2">Timeline</div>
                <div className="space-y-1 rounded-lg border border-line bg-panel p-3">
                    {[...nodes].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((n) => {
                        const s = ((Date.parse(n.startedAt) - t0) / (t1 - t0)) * 100, w = Math.max(1.5, ((Date.parse(n.lastAt) - Date.parse(n.startedAt)) / (t1 - t0)) * 100)
                        return (
                            <Link key={n.id} href={`/transcripts/${n.id}`} className="flex items-center gap-2 text-[11px] hover:text-fg" title={n.description}>
                                <span className="w-32 truncate text-dim">{n.agentId ? n.agentType || 'agent' : 'main'}</span>
                                <span className="relative h-3 flex-1 rounded bg-bg"><span className={`absolute top-0 h-3 rounded ${n.id === current ? 'bg-accent' : 'bg-accent/50'}`} style={{ left: `${Math.min(s, 98)}%`, width: `${Math.min(w, 100 - Math.min(s, 98))}%` }} /></span>
                            </Link>
                        )
                    })}
                </div>
            </section>
        </div>
    )
}
