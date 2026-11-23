'use client'
import { useRef, useState } from 'react'
import { api } from '~/trpc/react'

export const TYPES = ['auto', 'model', 'texture', 'sound', 'animation', 'map', 'other'] as const
const ACCEPT_HINT = 'models: glb gltf obj fbx dae stl ply blend; textures: png jpg webp tga dds ...; sounds: ogg wav mp3 flac; maps: bsp vmf map json glb obj'
const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)

/** Drop zone + form shared by the Asset Manager and the Map Manager: POSTs to /api/tools/upload (validated and stored by `nightly assets upload`). */
export function UploadPanel({ projectSlug, fixedType, onDone, title }: { projectSlug?: string; fixedType?: (typeof TYPES)[number]; onDone?: () => void; title?: string }) {
    const [files, setFiles] = useState<File[]>([])
    const [type, setType] = useState<string>(fixedType ?? 'auto')
    const [pack, setPack] = useState('')
    const [note, setNote] = useState('')
    const [busy, setBusy] = useState(false)
    const [msgs, setMsgs] = useState<{ ok: boolean; text: string }[]>([])
    const [over, setOver] = useState(false)
    const input = useRef<HTMLInputElement>(null)
    const limits = api.tools.limits.useQuery()
    const utils = api.useUtils()
    const maxMb = Number(limits.data?.uploadMaxMb ?? 0)

    const send = async () => {
        setBusy(true); setMsgs([])
        const bins = files.filter((f) => /\.bin$/i.test(f.name))
        const main = files.filter((f) => !/\.bin$/i.test(f.name))
        const out: { ok: boolean; text: string }[] = []
        for (const f of main) {
            if (maxMb > 0 && f.size > maxMb * 1048576) { out.push({ ok: false, text: `${f.name}: ${mb(f.size)} is over the ${maxMb} MB limit` }); continue }
            const fd = new FormData()
            fd.set('file', f)
            if (type !== 'auto') fd.set('type', type)
            if (pack) fd.set('pack', pack)
            if (note) fd.set('note', note)
            if (projectSlug) fd.set('project', projectSlug)
            const stem = f.name.replace(/\.[^.]+$/, '')
            const bin = bins.find((b) => b.name.replace(/\.[^.]+$/, '') === stem) ?? (main.length === 1 && bins.length === 1 ? bins[0] : undefined)
            if (bin) fd.set('bin', bin)
            try {
                const r = await fetch('/api/tools/upload', { method: 'POST', body: fd })
                const j = (await r.json()) as { error?: string; name?: string; type?: string; pack?: string; warnings?: string[] }
                out.push(r.ok ? { ok: true, text: `${j.name}: stored as ${j.type} in ${j.pack}${j.warnings?.length ? ` (${j.warnings.join('; ')})` : ''}` } : { ok: false, text: `${f.name}: ${j.error ?? r.statusText}` })
            } catch (e) { out.push({ ok: false, text: `${f.name}: ${(e as Error).message}` }) }
        }
        setMsgs(out); setBusy(false); setFiles([])
        void utils.tools.invalidate(); onDone?.()
    }
    return (
        <section className="rounded-lg border border-line bg-panel p-3">
            <div className="mb-2 flex items-baseline justify-between"><h2 className="text-[13px] font-semibold">{title ?? 'Upload'}</h2><span className="text-[11.5px] text-muted">{maxMb > 0 ? `limit ${maxMb} MB per file` : 'no size limit'}</span></div>
            <div
                onDragOver={(e) => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); setFiles([...files, ...Array.from(e.dataTransfer.files)]) }}
                onClick={() => input.current?.click()}
                className={`grid cursor-pointer place-items-center rounded-md border border-dashed px-4 py-6 text-center text-[12.5px] transition ${over ? 'border-accent bg-hover' : 'border-line-strong text-dim hover:bg-hover'}`}>
                {files.length ? <span className="text-fg">{files.map((f) => `${f.name} (${mb(f.size)})`).join(', ')}</span> : <span>Drop files here or click to choose<br /><span className="text-[11px] text-muted">{ACCEPT_HINT}</span></span>}
                <input ref={input} type="file" multiple hidden onChange={(e) => setFiles([...files, ...Array.from(e.target.files ?? [])])} />
            </div>
            <div className="mt-2 flex flex-wrap items-end gap-2">
                {!fixedType && <label className="grid gap-1"><span className="label">Type</span><select className="select" value={type} onChange={(e) => setType(e.target.value)}>{TYPES.map((t) => <option key={t} value={t}>{t === 'auto' ? 'detect from file' : t}</option>)}</select></label>}
                <label className="grid gap-1"><span className="label">Pack</span><input className="input w-36" placeholder="uploads" value={pack} onChange={(e) => setPack(e.target.value)} /></label>
                <label className="grid min-w-40 flex-1 gap-1"><span className="label">Note</span><input className="input" value={note} onChange={(e) => setNote(e.target.value)} /></label>
                <button className="btn-primary btn" disabled={busy || !files.length} onClick={() => void send()}>{busy ? 'Uploading...' : `Upload ${files.length || ''}`}</button>
                {!!files.length && !busy && <button className="btn" onClick={() => setFiles([])}>Clear</button>}
            </div>
            {msgs.map((m, i) => <p key={i} className={`mt-1.5 text-[12px] ${m.ok ? 'text-emerald-300' : 'text-red-300'}`}>{m.text}</p>)}
        </section>
    )
}

/** Recent uploads table (newest first). */
export function RecentUploads({ type }: { type?: string }) {
    const q = api.tools.uploads.useQuery({ type })
    if (!q.data?.length) return null
    return (
        <section className="mt-3">
            <h3 className="mb-1 text-[12px] font-medium text-muted">Recent uploads</h3>
            <table className="w-full text-[12.5px]"><tbody>{q.data.slice(0, 8).map((u) => (
                <tr key={u.id} className="border-b border-line/50"><td className="py-1 pr-2">{u.name}</td><td className="px-2 text-dim">{u.type}</td><td className="px-2 text-dim">{u.pack}</td><td className="px-2 tabular-nums text-dim">{mb(Number(u.bytes))}</td><td className="px-2 text-muted">{u.uploadedBy}</td><td className="px-2 text-muted">{u.uploadedAt.slice(0, 16).replace('T', ' ')}</td></tr>
            ))}</tbody></table>
        </section>
    )
}
