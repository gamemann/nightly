'use client'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { Empty, Err, Field, Page } from './nodes/ui'

type F = { id?: number; projectId: number; name: string; command: string; heavy: boolean; nodeKinds: string; timeout: number; enabled: boolean }
const JOB_COLOR: Record<string, string> = { queued: 'text-amber-300', running: 'text-sky-300', done: 'text-teal-300', failed: 'text-red-300', cancelled: 'text-muted' }

export function Builds() {
    const utils = api.useUtils()
    const list = api.nodeOps.builds.list.useQuery(undefined, { refetchInterval: 4000 })
    const jobs = api.nodeOps.jobs.list.useQuery({ take: 30 }, { refetchInterval: 3000 })
    const [f, setF] = useState<F | null>(null)
    const [open, setOpen] = useState<number | null>(null)
    const det = api.nodeOps.builds.detect.useQuery({ command: f?.command ?? '' }, { enabled: !!f?.command })
    const done = () => void utils.nodeOps.invalidate()
    const save = api.nodeOps.builds.save.useMutation({ onSuccess: () => { setF(null); done() } })
    const remove = api.nodeOps.builds.remove.useMutation({ onSuccess: done })
    const run = api.nodeOps.builds.run.useMutation({ onSuccess: done })
    const cancel = api.nodeOps.jobs.cancel.useMutation({ onSuccess: done })
    const projects = list.data?.projects ?? []
    return (
        <Page title="Builds" actions={<button className="btn-primary btn" onClick={() => setF({ projectId: projects[0]?.id ?? 0, name: '', command: '', heavy: false, nodeKinds: 'build', timeout: 0, enabled: true })}>Add build</button>}
            sub="Per-project build, test and suite commands. Each run is queued and sent to a node that offers its kind and has a free slot; GPU and browser runs only go to nodes with a GPU. Heavy commands (cargo, tsc, game suites) are detected automatically and take a heavy slot.">
            <Err e={save.error ?? remove.error ?? run.error ?? cancel.error} />
            {f && (
                <div className="my-3 rounded-lg border border-line p-3">
                    <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
                        <Field label="Project"><select className="select" value={f.projectId} onChange={(e) => setF({ ...f, projectId: Number(e.target.value) })}>{projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
                        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
                        <Field label="Kinds (comma separated)"><input className="input" value={f.nodeKinds} onChange={(e) => setF({ ...f, nodeKinds: e.target.value })} /></Field>
                        <Field label="Timeout (s, 0 = none)"><input className="input" type="number" value={f.timeout} onChange={(e) => setF({ ...f, timeout: Number(e.target.value) })} /></Field>
                        <Field label="Command" wide><input className="input font-mono" value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} /></Field>
                        <label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={f.heavy} onChange={(e) => setF({ ...f, heavy: e.target.checked })} />Heavy{det.data?.heavy && !f.heavy ? ' (detected: will be treated as heavy)' : ''}</label>
                        <label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={f.enabled} onChange={(e) => setF({ ...f, enabled: e.target.checked })} />Enabled</label>
                    </div>
                    {det.data && <div className="mt-2 text-[12px] text-muted">Detected kinds: {det.data.kinds.join(', ') || 'none'}; heavy: {det.data.heavy ? 'yes' : 'no'}
                        {det.data.kinds.length > 0 && <button className="btn ml-2" onClick={() => setF({ ...f, nodeKinds: det.data!.kinds.join(','), heavy: f.heavy || det.data!.heavy })}>Use</button>}</div>}
                    <div className="mt-3 flex gap-2">
                        <button className="btn-primary btn" disabled={!f.name || !f.command || !f.projectId} onClick={() => save.mutate(f)}>Save</button>
                        <button className="btn" onClick={() => setF(null)}>Cancel</button>
                    </div>
                </div>
            )}
            {list.data?.builds.length === 0 && <Empty>No build configs yet.</Empty>}
            <div className="space-y-2">
                {list.data?.builds.map((b) => (
                    <div key={b.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line px-3 py-2.5">
                        <span className="font-medium">{b.project.name}</span><span className="text-muted">/</span><span>{b.name}</span>
                        <code className="truncate font-mono text-[11px] text-muted">{b.command}</code>
                        {(b.heavy || b.heavyAuto) && <span className="rounded bg-amber-400/15 px-1.5 text-[10px] uppercase text-amber-300">heavy</span>}
                        <span className="text-[11px] text-muted">{b.nodeKinds}</span>
                        <span className="flex-1" />
                        {b.last && <span className={`text-[11px] ${JOB_COLOR[b.last.status] ?? ''}`}>{b.last.status}{b.last.exitCode != null ? ` (${b.last.exitCode})` : ''}</span>}
                        <button className="btn" disabled={!b.enabled || run.isPending} onClick={() => run.mutate({ id: b.id })}>Run</button>
                        <button className="btn" onClick={() => setF({ id: b.id, projectId: b.projectId, name: b.name, command: b.command, heavy: b.heavy, nodeKinds: b.nodeKinds, timeout: b.timeout, enabled: b.enabled })}>Edit</button>
                        <button className="btn" onClick={() => confirm(`Delete ${b.name}?`) && remove.mutate({ id: b.id })}>Delete</button>
                    </div>
                ))}
            </div>
            <div className="label mt-5 mb-2">Recent jobs</div>
            <div className="space-y-1">
                {jobs.data?.map((j) => (
                    <div key={j.id} className="rounded border border-line px-3 py-1.5 text-[12px]">
                        <div className="flex items-center gap-2">
                            <button className="font-medium hover:underline" onClick={() => setOpen(open === j.id ? null : j.id)}>#{j.id} {j.name}</button>
                            <span className={JOB_COLOR[j.status] ?? ''}>{j.status}{j.exitCode != null ? ` (${j.exitCode})` : ''}</span>
                            <span className="text-muted">{j.node ?? 'unassigned'} · {j.kind}</span>
                            <span className="flex-1" />
                            {(j.status === 'queued' || j.status === 'running') && <button className="btn" onClick={() => cancel.mutate({ id: j.id })}>Cancel</button>}
                        </div>
                        {open === j.id && <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-muted">{j.log || '(no output yet)'}</pre>}
                    </div>
                ))}
            </div>
        </Page>
    )
}
