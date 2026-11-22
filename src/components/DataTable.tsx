'use client'
import { useEffect, useRef, useState } from 'react'
import type { Paged } from '~/lib/paging'
import { Pagination, useUrlParams } from './Pagination'

export type Column<T> = { key: string; label: string; sortable?: boolean; className?: string; render: (r: T) => React.ReactNode }
export type Facet = { key: string; label: string; options: { value: string; label?: string }[] }

/** Search box, facet selects and (for card lists that have no sortable headers) a sort picker, all in URL params. DataTable renders it
 *  above its table; lists of cards use it directly. */
export function ListControls({ q, filters = [], active = {}, searchHint = 'Search', sorts = [], sort = '', dir = 'asc', toolbar, ns = '' }: {
    q: string; filters?: Facet[]; active?: Record<string, string>; searchHint?: string; sorts?: { key: string; label: string }[]; sort?: string; dir?: 'asc' | 'desc'
    toolbar?: React.ReactNode; ns?: string
}) {
    const { set } = useUrlParams(ns)
    const [text, setText] = useState(q)
    const first = useRef(true)
    useEffect(() => setText(q), [q])
    useEffect(() => {
        if (first.current) { first.current = false; return }
        if (text === q) return
        const t = setTimeout(() => set({ q: text }), 300)
        return () => clearTimeout(t)
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [text])
    const sel = 'rounded-md border border-line bg-panel px-2 py-1 text-[12px]'
    return (
        <div className="mb-2 flex flex-wrap items-center gap-2">
            <input className={`${sel} w-56`} placeholder={searchHint} value={text} onChange={(e) => setText(e.target.value)} aria-label="search" />
            {filters.map((f) => (
                <select key={f.key} className={sel} value={active[f.key] ?? ''} onChange={(e) => set({ [f.key]: e.target.value })} aria-label={f.label}>
                    <option value="">{f.label}: all</option>
                    {f.options.map((o) => <option key={o.value} value={o.value}>{o.label ?? o.value}</option>)}
                </select>
            ))}
            {sorts.length > 0 && (
                <span className="flex items-center gap-1">
                    <select className={sel} value={sort} onChange={(e) => set({ sort: e.target.value })} aria-label="sort by">
                        {sorts.map((o) => <option key={o.key} value={o.key}>Sort: {o.label}</option>)}
                    </select>
                    <button className={sel} onClick={() => set({ dir: dir === 'asc' ? 'desc' : 'asc' })} aria-label="sort direction">{dir === 'asc' ? '▲' : '▼'}</button>
                </span>
            )}
            {toolbar}
        </div>
    )
}

/** The one table of the panel: server-side sort (click a header), facet filters, text search and paging, all in URL params.
 *  The rows are already one page; the server did the sorting, filtering and counting. */
export function DataTable<T>({ cols, data, rowKey, sort, dir, q, filters = [], active = {}, searchHint = 'Search', empty = 'Nothing matches.', toolbar, rowClass, ns = '' }: {
    cols: Column<T>[]; data: Paged<T>; rowKey: (r: T) => string | number; sort: string; dir: 'asc' | 'desc'; q: string
    filters?: Facet[]; active?: Record<string, string>; searchHint?: string; empty?: string; toolbar?: React.ReactNode; rowClass?: (r: T) => string; ns?: string
}) {
    const { set } = useUrlParams(ns)
    return (
        <div>
            <ListControls q={q} filters={filters} active={active} searchHint={searchHint} toolbar={toolbar} ns={ns} />
            <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-[12.5px]">
                    <thead className="border-b border-line bg-panel/60">
                        <tr>
                            {cols.map((c) => (
                                <th key={c.key} className={`px-2 py-1 text-left font-medium text-dim ${c.sortable ? 'cursor-pointer select-none hover:text-fg' : ''}`}
                                    aria-sort={sort === c.key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}
                                    onClick={c.sortable ? () => set({ sort: c.key, dir: sort === c.key && dir === 'asc' ? 'desc' : 'asc' }) : undefined}>
                                    {c.label}{sort === c.key ? (dir === 'asc' ? ' ▲' : ' ▼') : ''}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {data.rows.map((r) => (
                            <tr key={rowKey(r)} className={`border-b border-line/50 hover:bg-hover/40 ${rowClass?.(r) ?? ''}`}>
                                {cols.map((c) => <td key={c.key} className={`px-2 py-1 ${c.className ?? ''}`}>{c.render(r)}</td>)}
                            </tr>
                        ))}
                        {!data.rows.length && <tr><td colSpan={cols.length} className="px-2 py-6 text-center text-muted">{empty}</td></tr>}
                    </tbody>
                </table>
            </div>
            <Pagination p={data} ns={ns} />
        </div>
    )
}
