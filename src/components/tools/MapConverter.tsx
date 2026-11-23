'use client'
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '~/trpc/react'
import type { JobView } from '~/server/toolsRouter'

const FORMAT_LABEL: Record<string, string> = { bsp: 'BSP (compiled)', vmf: 'VMF', 'quake-map': 'Quake .map', 'gs-map': 'GameSpice map', glb: 'glTF binary (.glb)', gltf: 'glTF', obj: 'OBJ', fbx: 'FBX', dae: 'Collada' }
const EXT_FROM: Record<string, string> = { bsp: 'bsp', vmf: 'vmf', map: 'quake-map', json: 'gs-map', glb: 'glb', gltf: 'gltf', obj: 'obj', fbx: 'fbx', dae: 'dae' }
const kb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`)
const STATUS: Record<string, string> = { queued: 'text-dim', running: 'text-sky-300', done: 'text-emerald-300', partial: 'text-amber-300', failed: 'text-red-300' }

/** The Map Converter: pick a map, pick a target format, run it as a job (progress and log), download the results and review how its textures mapped. */
export function MapConverter({ projectSlug }: { projectSlug?: string }) {
    const formats = api.tools.formats.useQuery()
    const [file, setFile] = useState<File | null>(null)
    const [to, setTo] = useState('')
    const [jobId, setJobId] = useState<number | null>(null)
    const [err, setErr] = useState('')
    const [busy, setBusy] = useState(false)
    const input = useRef<HTMLInputElement>(null)
    const binInput = useRef<HTMLInputElement>(null)
    const [bin, setBin] = useState<File | null>(null)
    const from = file ? EXT_FROM[file.name.split('.').pop()?.toLowerCase() ?? ''] ?? '' : ''
    const targets = useMemo(() => {
        const rows = formats.data ?? []
        const seen = new Set([from]), q = [from]
        while (q.length) { const f = q.shift(); for (const c of rows) if (c.from === f && !c.available && !seen.has(c.to)) { seen.add(c.to); q.push(c.to) } }
        seen.delete(from)
        return [...seen]
    }, [formats.data, from])
    useEffect(() => { if (to && !targets.includes(to)) setTo('') }, [targets, to])
    const job = api.tools.mapJob.useQuery({ id: jobId ?? 0 }, { enabled: jobId != null, refetchInterval: (q) => (['queued', 'running'].includes(q.state.data?.status ?? 'queued') ? 1500 : false) })
    const jobs = api.tools.mapJobs.useQuery({ project: projectSlug })
    const utils = api.useUtils()
    const start = async () => {
        if (!file || !to) return
        setBusy(true); setErr('')
        const fd = new FormData(); fd.set('file', file); fd.set('to', to); if (projectSlug) fd.set('project', projectSlug); if (bin && from === 'gs-map') fd.set('bin', bin)
        try {
            const r = await fetch('/api/tools/map-convert', { method: 'POST', body: fd })
            const j = (await r.json()) as { id?: number; error?: string }
            if (!r.ok || j.id == null) setErr(j.error ?? r.statusText); else { setJobId(j.id); void utils.tools.mapJobs.invalidate() }
        } catch (e) { setErr((e as Error).message) }
        setBusy(false)
    }
    const unavailable = (formats.data ?? []).filter((c) => c.available)
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">Map Converter{projectSlug ? <span className="ml-2 text-[12px] font-normal text-muted">{projectSlug}</span> : null}</h1>
            <p className="mt-1 text-[12.5px] text-dim">Convert between BSP, VMF, Quake .map, GameSpice maps and glTF. Chained steps run as one job; the textures are matched to the Asset Manager and reported below.</p>
            <section className="mt-3 rounded-lg border border-line bg-panel p-3">
                <div className="flex flex-wrap items-end gap-3">
                    <div className="grid gap-1"><span className="label">Map file</span><button className="btn" onClick={() => input.current?.click()}>{file ? `${file.name} (${kb(file.size)})` : 'Choose a file'}</button><input ref={input} type="file" hidden accept=".bsp,.vmf,.map,.json,.glb,.gltf,.obj,.fbx,.dae" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></div>
                    {from === 'gs-map' && <div className="grid gap-1"><span className="label">Geometry (.bin, mesh maps)</span><button className="btn" title="A GameSpice mesh map is a .json manifest plus its .bin geometry" onClick={() => binInput.current?.click()}>{bin ? `${bin.name} (${kb(bin.size)})` : 'Choose the .bin'}</button><input ref={binInput} type="file" hidden accept=".bin" onChange={(e) => setBin(e.target.files?.[0] ?? null)} /></div>}
                    <label className="grid gap-1"><span className="label">Convert to</span><select className="select" value={to} disabled={!file} onChange={(e) => setTo(e.target.value)}><option value="">{file ? (targets.length ? 'choose' : 'no route available') : 'choose a file first'}</option>{targets.map((t) => <option key={t} value={t}>{FORMAT_LABEL[t] ?? t}</option>)}</select></label>
                    <button className="btn-primary btn" disabled={!file || !to || busy} onClick={() => void start()}>{busy ? 'Starting...' : 'Convert'}</button>
                </div>
                {file && !from && <p className="mt-2 text-[12px] text-red-300">Unrecognised file type. Accepted: bsp, vmf, map, json (GameSpice), glb, gltf, obj, fbx, dae.</p>}
                {err && <p className="mt-2 text-[12px] text-red-300">{err}</p>}
                {!!unavailable.length && <details className="mt-2 text-[11.5px] text-muted"><summary className="cursor-pointer">{unavailable.length} converter{unavailable.length > 1 ? 's' : ''} unavailable on this machine</summary>{unavailable.map((c) => <p key={c.id}>{c.label}: {c.available}</p>)}</details>}
            </section>
            {job.data && <JobPanel job={job.data} />}
            <section className="mt-4">
                <h2 className="mb-1 text-[12px] font-medium text-muted">Recent jobs</h2>
                <table className="w-full text-[12.5px]"><tbody>{(jobs.data ?? []).map((j) => (
                    <tr key={j.id} className="cursor-pointer border-b border-line/50 hover:bg-hover" onClick={() => setJobId(j.id)}><td className="py-1 pr-2 tabular-nums text-dim">#{j.id}</td><td className="px-2">{j.input}</td><td className="px-2 text-dim">{j.from} to {j.to}</td><td className={`px-2 ${STATUS[j.status] ?? ''}`}>{j.status}</td><td className="px-2 text-muted">{j.createdAt.slice(0, 16).replace('T', ' ')}</td></tr>
                ))}</tbody></table>
                {!jobs.data?.length && <p className="text-[12.5px] text-dim">No conversions yet.</p>}
            </section>
        </div>
    )
}

function JobPanel({ job }: { job: JobView }) {
    const m = job.report.materials ?? []
    const c = job.report.counts ?? {}
    return (
        <section className="mt-3 rounded-lg border border-line bg-panel p-3">
            <div className="flex items-baseline justify-between"><h2 className="text-[13px] font-semibold">Job #{job.id}: {job.input} to {job.to}</h2><span className={`text-[12px] ${STATUS[job.status] ?? ''}`}>{job.status} {Math.round(job.progress * 100)}%</span></div>
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-hover"><div className={`h-full ${job.status === 'failed' ? 'bg-red-400' : 'bg-accent'}`} style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
            {job.error && <p className="mt-2 text-[12.5px] text-red-300">{job.error}</p>}
            {job.warnings.map((w, i) => <p key={i} className="mt-1 text-[12px] text-amber-300">{w}</p>)}
            {!!job.outputs.length && <div className="mt-3"><h3 className="label mb-1">Results</h3><div className="flex flex-wrap gap-2">{job.outputs.map((o) => <a key={o.name} className="btn" href={`/api/tools/map-convert/${job.id}/${encodeURIComponent(o.name)}`} download>{o.name} <span className="text-muted">{kb(o.bytes)}</span></a>)}</div></div>}
            {!!m.length && (
                <div className="mt-3">
                    <h3 className="label mb-1">Texture mapping: {c.resolved ?? 0} resolved, {c.generated ?? 0} generated, {c.unmapped ?? 0} unmapped</h3>
                    <div className="max-h-72 overflow-auto rounded border border-line">
                        <table className="w-full text-[12px]"><thead className="sticky top-0 bg-panel-2 text-muted"><tr><th className="px-2 py-1 text-left font-normal">Material</th><th className="px-2 text-left font-normal">Triangles</th><th className="px-2 text-left font-normal">Status</th><th className="px-2 text-left font-normal">Replacement</th></tr></thead>
                            <tbody>{m.map((x) => (
                                <tr key={x.name} className="border-t border-line/50"><td className="px-2 py-1 font-mono">{x.name}</td><td className="px-2 tabular-nums text-dim">{x.tris}</td>
                                    <td className={`px-2 ${x.status === 'resolved' ? 'text-emerald-300' : x.status === 'generated' ? 'text-sky-300' : 'text-amber-300'}`}>{x.status}</td>
                                    <td className="px-2 text-dim">{x.asset ? <Link className="text-sky-300 hover:underline" href={`/tools/assets/${x.asset.id}`}>{x.asset.pack}/{x.asset.weaponId}</Link> : x.texture ?? ''}{x.credit ? ` (${x.credit})` : ''}{!x.asset && x.status === 'unmapped' ? <Link className="ml-1 text-sky-300 hover:underline" href="/tools/assets?tab=textures">find in Asset Manager</Link> : null}</td></tr>
                            ))}</tbody></table>
                    </div>
                </div>
            )}
            <details className="mt-3"><summary className="cursor-pointer text-[12px] text-muted">Log</summary><pre className="mt-1 max-h-60 overflow-auto rounded bg-bg p-2 text-[11.5px] text-dim">{job.log}</pre></details>
        </section>
    )
}
