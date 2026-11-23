'use client'
import Link from 'next/link'
import { useParams, usePathname } from 'next/navigation'
import { ConvList } from './ConvList'
import { HistoryButton } from './HistoryMenu'

export function Shell({ children }: { children: React.ReactNode }) {
    const params = useParams<{ id?: string }>()
    const path = usePathname()
    const id = params?.id && /^\d+$/.test(params.id) ? Number(params.id) : undefined
    const tab = (href: string, label: string, on: boolean) => <Link href={href} className={`rounded px-2 py-0.5 text-[12px] ${on ? 'bg-hover text-fg' : 'text-dim hover:text-fg'}`}>{label}</Link>
    return (
        <div className="flex h-screen min-h-0">
            <aside className="flex w-72 shrink-0 flex-col border-r border-line bg-panel max-lg:w-56">
                <div className="flex items-center gap-1 border-b border-line px-2 py-2">
                    {tab('/transcripts', 'Chats', !path.startsWith('/transcripts/agents'))}
                    {tab('/transcripts/agents', 'Agents', path.startsWith('/transcripts/agents'))}
                    <span className="flex-1" />
                    <HistoryButton />
                    <Link href="/transcripts/new" className="icon-btn" title="New conversation">＋</Link>
                </div>
                <div className="min-h-0 flex-1"><ConvList activeId={id} /></div>
            </aside>
            <section className="min-w-0 flex-1">{children}</section>
        </div>
    )
}
