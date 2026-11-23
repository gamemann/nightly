import Link from 'next/link'
import type { ReactNode } from 'react'

// Small building blocks every page of the new shell uses. Server-safe (no hooks).

export function PageHeader({ title, sub, actions, children }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
    return (
        <header className="border-b border-line/70 px-6 pb-3 pt-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div className="min-w-0">
                    <h1 className="glow-text text-lg font-semibold tracking-tight">{title}</h1>
                    {sub && <p className="mt-0.5 text-[13px] text-dim">{sub}</p>}
                </div>
                {actions && <div className="flex items-center gap-2">{actions}</div>}
            </div>
            {children}
        </header>
    )
}

export function EmptyState({ title, children }: { title: ReactNode; children?: ReactNode }) {
    return (
        <div className="glow-card mx-auto my-10 max-w-md p-6 text-center">
            <div className="text-sm font-medium">{title}</div>
            {children && <div className="mt-1.5 text-[13px] text-dim">{children}</div>}
        </div>
    )
}

export function NoAccess({ perm }: { perm: string | string[] }) {
    return (
        <EmptyState title="No access">
            This page needs the permission {(Array.isArray(perm) ? perm : [perm]).map((p) => <code key={p} className="mx-0.5 rounded bg-panel-2 px-1">{p}</code>)}. Ask an admin.
        </EmptyState>
    )
}

/** A page a later phase fills in. The page renders this until its component lands. */
export function Scaffold({ title, phase, children, links }: { title: string; phase: number; children: ReactNode; links?: [string, string][] }) {
    return (
        <div>
            <PageHeader title={title} sub={`Coming in phase ${phase}`} />
            <div className="glow-card m-6 max-w-2xl space-y-3 p-5 text-[13px] text-dim">
                <div>{children}</div>
                {links?.length ? (
                    <div className="flex flex-wrap gap-2 pt-1">
                        {links.map(([href, label]) => <Link key={href} href={href} className="btn">{label}</Link>)}
                    </div>
                ) : null}
            </div>
        </div>
    )
}

/** Tabs as links (server-rendered). `active` is the href of the current tab. */
export function LinkTabs({ tabs, active }: { tabs: readonly (readonly [string, string])[]; active: string }) {
    return (
        <nav className="flex gap-1 overflow-x-auto border-b border-line/70 px-6 pt-3 text-[13px]">
            {tabs.map(([href, label]) => (
                <Link key={href} href={href} className={`whitespace-nowrap rounded-t px-3 py-1.5 ${href === active ? 'bg-hover text-fg shadow-[inset_0_-2px_0] shadow-accent' : 'text-dim hover:text-fg'}`}>{label}</Link>
            ))}
        </nav>
    )
}
