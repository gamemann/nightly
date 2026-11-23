'use client'
import type { ReactNode } from 'react'

// Form bits shared by the account, project and admin pages.

export function Field({ label, hint, children, className = '' }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <label className={`block space-y-1 ${className}`}>
            <span className="label">{label}</span>
            {children}
            {hint && <span className="block text-[11px] text-muted">{hint}</span>}
        </label>
    )
}

export function ErrorLine({ error }: { error?: { message: string } | null }) {
    return error ? <p className="text-[12px] text-red-400">{error.message}</p> : null
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <section className={`glow-card p-4 ${className}`}>
            {(title || actions) && (
                <div className="mb-3 flex items-center justify-between gap-2">
                    {title && <h2 className="text-[13px] font-semibold">{title}</h2>}
                    {actions}
                </div>
            )}
            {children}
        </section>
    )
}

export const when = (d: Date | string | number | null | undefined) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '-')

export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
    return (
        <div className="overflow-x-auto">
            <table className="w-full text-left text-[12.5px]">
                <thead className="text-[11px] uppercase tracking-wide text-muted">
                    <tr>{head.map((h, i) => <th key={i} className="border-b border-line/70 px-2 py-1.5 font-medium">{h}</th>)}</tr>
                </thead>
                <tbody className="[&_td]:border-b [&_td]:border-line/40 [&_td]:px-2 [&_td]:py-1.5">{children}</tbody>
            </table>
        </div>
    )
}
