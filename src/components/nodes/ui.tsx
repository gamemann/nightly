'use client'
import type { ReactNode } from 'react'

export const STATE_COLOR: Record<string, string> = { online: 'bg-teal-400 shadow-[0_0_6px] shadow-teal-400', connecting: 'bg-amber-400', denied: 'bg-red-400', offline: 'bg-zinc-600' }

export function Page({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <div className="flex items-start justify-between gap-3">
                <h1 className="text-[15px] font-semibold tracking-tight">{title}</h1>
                <div className="flex items-center gap-2">{actions}</div>
            </div>
            {sub && <p className="mt-0.5 mb-4 text-[12px] text-muted">{sub}</p>}
            {children}
        </div>
    )
}

export const Dot = ({ state }: { state: string }) => <span title={state} className={`inline-block size-2 shrink-0 rounded-full ${STATE_COLOR[state] ?? STATE_COLOR.offline}`} />

export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
    return (
        <label className={`flex flex-col gap-1 ${wide ? 'col-span-2' : ''}`}>
            <span className="label">{label}</span>
            {children}
        </label>
    )
}

export const Err = ({ e }: { e: { message: string } | null }) => (e ? <div className="rounded border border-red-400/30 bg-red-400/10 px-2 py-1 text-[12px] text-red-300">{e.message}</div> : null)
export const Empty = ({ children }: { children: ReactNode }) => <div className="rounded-lg border border-line px-3 py-6 text-center text-[12px] text-muted">{children}</div>
