'use client'
import { useState } from 'react'

// One small add/edit form shared by the crash, web, playtest and content pages. Values are strings; the server (lib/feeds.mjs) validates and coerces.
export type FieldDef = { name: string; placeholder?: string; options?: string[]; locked?: boolean; wide?: boolean }
export const field = 'rounded border border-line bg-panel px-2 py-1 text-[12px]'

export function FeedForm({ fields, initial, isNew, onSave, onDelete, onCancel, busy, error }: {
    fields: FieldDef[]; initial: Record<string, string>; isNew: boolean; busy?: boolean; error?: string
    onSave: (v: Record<string, string>) => void; onDelete?: () => void; onCancel: () => void
}) {
    const [v, setV] = useState(initial)
    const set = (name: string, x: string) => setV({ ...v, [name]: x })
    const save = () => onSave(Object.fromEntries(fields.filter((f) => isNew || !f.locked).map((f) => [f.name, v[f.name] ?? '']).filter(([, x]) => isNew ? x !== '' : true)))
    return (
        <div className="mb-4 grid gap-2 rounded-lg border border-line p-3 text-[12px]">
            <div className="flex flex-wrap gap-2">
                {fields.map((f) => f.options
                    ? <select key={f.name} className={field} aria-label={f.name} value={v[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)}>{f.options.map((o) => <option key={o}>{o}</option>)}</select>
                    : f.wide
                        ? <textarea key={f.name} className={`${field} min-h-[60px] w-full font-mono`} aria-label={f.name} placeholder={f.placeholder ?? f.name} value={v[f.name] ?? ''} onChange={(e) => set(f.name, e.target.value)} />
                        : <input key={f.name} className={field} aria-label={f.name} placeholder={f.placeholder ?? f.name} value={v[f.name] ?? ''} disabled={!isNew && f.locked} onChange={(e) => set(f.name, e.target.value)} />)}
            </div>
            <div className="flex flex-wrap items-center gap-2">
                {error && <span className="text-red-300">{error}</span>}
                <span className="flex-1" />
                <button className={field} disabled={busy} onClick={save}>{isNew ? 'Add' : 'Save'}</button>
                {!isNew && onDelete && <button className={`${field} text-red-300`} disabled={busy} onClick={() => { if (confirm('Delete this row?')) onDelete() }}>Delete</button>}
                <button className={field} onClick={onCancel}>Cancel</button>
            </div>
        </div>
    )
}
