'use client'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { PAGE_SIZES, type Paged } from '~/lib/paging'

/** Writes some URL params (empty removes them) and keeps the others; any change except `page` itself returns to page 1. */
export function useUrlParams(ns = '') {
    const router = useRouter()
    const path = usePathname()
    const sp = useSearchParams()
    const set = (o: Record<string, string>) => {
        const n = new URLSearchParams(sp.toString())
        for (const [k, v] of Object.entries(o)) v ? n.set(ns + k, v) : n.delete(ns + k)
        if (!('page' in o)) n.delete(ns + 'page')
        const s = n.toString()
        router.replace(s ? `${path}?${s}` : path, { scroll: false })
    }
    return { sp, set }
}

/** "rows a-b of N", page-size selector, prev/next and a page jump. Shared by every list. */
export function Pagination({ p, ns = '' }: { p: Pick<Paged<unknown>, 'total' | 'page' | 'size' | 'pages' | 'from' | 'to'>; ns?: string }) {
    const { set } = useUrlParams(ns)
    const [jump, setJump] = useState('')
    const go = (n: number) => set({ page: n <= 1 ? '' : String(Math.min(p.pages, n)) })
    const btn = 'rounded border border-line px-2 py-0.5 text-[12px] enabled:hover:bg-hover disabled:opacity-40'
    return (
        <div className="flex flex-wrap items-center justify-between gap-2 px-1 py-2 text-[12px] text-dim">
            <span className="tabular-nums">rows {p.from.toLocaleString("en-GB")}-{p.to.toLocaleString("en-GB")} of {p.total.toLocaleString("en-GB")}</span>
            <span className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1">per page
                    <select className="rounded border border-line bg-panel px-1 py-0.5" value={p.size} onChange={(e) => set({ size: e.target.value === String(PAGE_SIZES[0]) ? '' : e.target.value })}>
                        {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                    </select>
                </label>
                <button className={btn} disabled={p.page <= 1} onClick={() => go(p.page - 1)} aria-label="previous page">Prev</button>
                <form className="flex items-center gap-1" onSubmit={(e) => { e.preventDefault(); const n = Math.floor(Number(jump)); if (n >= 1) go(n); setJump('') }}>
                    page <input className="w-14 rounded border border-line bg-panel px-1 py-0.5 text-center tabular-nums" inputMode="numeric" placeholder={String(p.page)} value={jump} onChange={(e) => setJump(e.target.value)} aria-label="jump to page" />
                    of {p.pages.toLocaleString("en-GB")}
                </form>
                <button className={btn} disabled={p.page >= p.pages} onClick={() => go(p.page + 1)} aria-label="next page">Next</button>
            </span>
        </div>
    )
}
