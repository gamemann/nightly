'use client'
import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '~/trpc/react'
import { ConvRow } from './ConvList'

/** History button: a search popover that opens where the mouse clicked. */
export function HistoryButton() {
    const [at, setAt] = useState<{ x: number; y: number } | null>(null)
    const [q, setQ] = useState('')
    const ref = useRef<HTMLDivElement>(null)
    const router = useRouter()
    const list = api.transcripts.list.useQuery({ q, limit: 30 }, { enabled: !!at, placeholderData: (p) => p })
    useEffect(() => {
        if (!at) return
        const close = (e: MouseEvent | KeyboardEvent) => {
            if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setAt(null)
        }
        document.addEventListener('mousedown', close); document.addEventListener('keydown', close)
        return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close) }
    }, [at])
    const x = at ? Math.max(8, Math.min(at.x, window.innerWidth - 380)) : 0
    const y = at ? Math.max(8, Math.min(at.y, window.innerHeight - 440)) : 0
    return (
        <>
            <button className="icon-btn" title="History" onClick={(e) => setAt({ x: e.clientX, y: e.clientY })}>◷</button>
            {at && (
                <div ref={ref} style={{ left: x, top: y }} className="fixed z-50 flex h-[420px] w-[360px] flex-col overflow-hidden rounded-lg border border-line-strong bg-panel shadow-2xl">
                    <div className="border-b border-line p-2"><input autoFocus className="input w-full text-[12px]" placeholder="Search history" value={q} onChange={(e) => setQ(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && list.data?.[0]) { router.push(`/transcripts/${list.data[0].id}`); setAt(null) } }} /></div>
                    <div className="min-h-0 flex-1 overflow-auto">
                        {list.data?.map((c) => <ConvRow key={c.id} c={c as never} onPick={() => setAt(null)} />)}
                        {list.data && !list.data.length && <div className="p-4 text-center text-[12px] text-muted">No match.</div>}
                    </div>
                </div>
            )}
        </>
    )
}
