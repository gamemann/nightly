'use client'
import Link from 'next/link'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { ago } from '~/components/pills'
import { baseName, short } from './types'

export function ConvRow({ c, active, onPick }: { c: { id: number; title: string; description: string; cwd: string; lastAt: string; osUser: string; live?: boolean; messageCount: number }; active?: boolean; onPick?: () => void }) {
    return (
        <Link href={`/transcripts/${c.id}`} prefetch={false} onClick={onPick} className={`block border-b border-line/60 px-3 py-2 hover:bg-hover ${active ? 'bg-hover' : ''}`}>
            <div className="flex items-center gap-1.5">
                {c.live && <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-emerald-400" />}
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{short(c.title || c.description || '(untitled)', 80)}</span>
                <span className="shrink-0 text-[10px] text-muted">{ago(c.lastAt)}</span>
            </div>
            <div className="truncate font-mono text-[10.5px] text-muted">{baseName(c.cwd)} · {c.osUser} · {c.messageCount}</div>
        </Link>
    )
}

/** Left column: instant switching between conversations, with search. */
export function ConvList({ activeId }: { activeId?: number }) {
    const [q, setQ] = useState('')
    const list = api.transcripts.list.useQuery({ q, limit: 80 }, { refetchInterval: 10_000, placeholderData: (p) => p })
    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="p-2"><input className="input w-full text-[12px]" placeholder="Search conversations" value={q} onChange={(e) => setQ(e.target.value)} /></div>
            <div className="min-h-0 flex-1 overflow-auto">
                {list.error && <div className="p-3 text-[12px] text-red-300">{list.error.message}</div>}
                {list.data?.map((c) => <ConvRow key={c.id} c={c as never} active={c.id === activeId} />)}
                {list.data && !list.data.length && <div className="p-4 text-center text-[12px] text-muted">{q ? 'No match.' : 'Nothing indexed yet. The first scan can take a minute.'}</div>}
            </div>
        </div>
    )
}
