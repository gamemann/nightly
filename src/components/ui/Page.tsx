'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

/** Shared page shell for the ops pages: title, one-line hint, an optional tab strip (links) and right-side actions. */
export type TabDef = { href: string; label: string }
export function Page({ title, hint, tabs, actions, children, embedded }: { title: string; hint?: ReactNode; tabs?: TabDef[]; actions?: ReactNode; children: ReactNode; embedded?: boolean }) {
    const path = usePathname()
    return (
        <div className={embedded ? 'py-3' : 'mx-auto max-w-6xl px-6 py-5 max-md:px-3'}>
            <div className="flex flex-wrap items-center gap-3">
                <h1 className={`${embedded ? 'text-[13px]' : 'text-[15px]'} font-semibold tracking-tight`}>{title}</h1>
                <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>
            </div>
            {hint && <p className="mt-0.5 mb-3 text-[12px] text-muted">{hint}</p>}
            {tabs && (
                <div className="mb-4 flex gap-1 border-b border-line">
                    {tabs.map((t) => (
                        <Link key={t.href} href={t.href} className={`-mb-px border-b-2 px-3 py-1.5 text-[12px] ${path === t.href ? 'border-accent text-fg' : 'border-transparent text-dim hover:text-fg'}`}>{t.label}</Link>
                    ))}
                </div>
            )}
            {children}
        </div>
    )
}

export const TONE: Record<string, string> = {
    success: 'bg-emerald-400/15 text-emerald-300', ok: 'bg-emerald-400/15 text-emerald-300',
    failure: 'bg-red-400/15 text-red-300', failed: 'bg-red-400/15 text-red-300', error: 'bg-red-400/15 text-red-300', flagged: 'bg-amber-400/15 text-amber-300',
    running: 'bg-sky-400/15 text-sky-300', queued: 'bg-violet-400/15 text-violet-300', in_progress: 'bg-sky-400/15 text-sky-300',
    cancelled: 'bg-zinc-500/20 text-zinc-300', skipped: 'bg-zinc-500/20 text-zinc-300', unreadable: 'bg-red-400/15 text-red-300',
}
export const Pill = ({ v }: { v: string }) => <span className={`rounded px-1.5 py-0.5 text-[11px] ${TONE[v] ?? 'bg-zinc-500/20 text-zinc-300'}`}>{v}</span>
export const Err = ({ e }: { e?: { message: string } | null }) => (e ? <div className="mb-3 rounded border border-red-400/40 p-2 text-[12px] text-red-300">{e.message}</div> : null)
export const Empty = ({ children }: { children: ReactNode }) => <div className="rounded-lg border border-dashed border-line p-6 text-center text-[12px] text-muted">{children}</div>
export const TH = ({ children, right }: { children?: ReactNode; right?: boolean }) => <th className={`px-2 py-1.5 font-normal ${right ? 'text-right' : 'text-left'}`}>{children}</th>
export const ago = (ms: number | null | undefined) => {
    if (!ms) return '-'
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
    return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`
}
