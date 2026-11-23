'use client'
import { useState } from 'react'
import { api, type RouterOutputs } from '~/trpc/react'
import { Dot, Empty, Err, Field, Page } from './nodes/ui'

type Node = RouterOutputs['nodeOps']['list'][number]
type Form = { id?: number; name: string; type: string; host: string; port: number; tls: boolean; notes: string; cpuModel: string; cores: number; threads: number; ramGb: number; gpu: string; buildSlots: number; heavySlots: number; kinds: string[]; workspace: string; paths: string }

const blank: Form = { name: '', type: 'station', host: '', port: 4001, tls: false, notes: '', cpuModel: '', cores: 0, threads: 0, ramGb: 0, gpu: '', buildSlots: 2, heavySlots: 1, kinds: ['build', 'test'], workspace: '', paths: '' }
const toForm = (n: Node): Form => ({ id: n.id, name: n.name, type: n.type, host: n.host, port: n.port, tls: n.tls, notes: n.notes, cpuModel: n.specs.cpu?.model ?? '', cores: n.specs.cpu?.cores ?? 0, threads: n.specs.cpu?.threads ?? 0, ramGb: n.specs.ram?.gb ?? 0, gpu: (n.specs.gpu ?? []).join('; '), buildSlots: n.specs.buildSlots ?? 2, heavySlots: n.specs.heavySlots ?? 1, kinds: n.specs.offloadKinds ?? [], workspace: n.specs.workspace ?? '', paths: Object.entries((n.specs.projectPaths ?? {}) as Record<string, string>).map(([k, v]) => `${k}=${v}`).join('; ') })
/** "fc=/srv/fc; web=/srv/web" -> { fc: '/srv/fc', web: '/srv/web' } */
const parsePaths = (t: string) => Object.fromEntries(t.split(/[;\n]/).map((x) => x.split('=').map((y) => y.trim())).filter((kv) => kv.length === 2 && kv[0] && kv[1]))
const specsOf = (f: Form) => ({
    cpu: f.cpuModel ? { model: f.cpuModel, cores: f.cores, threads: f.threads } : undefined,
    ram: f.ramGb ? { gb: f.ramGb } : undefined,
    gpu: f.gpu.split(';').map((s) => s.trim()).filter(Boolean),
    buildSlots: f.buildSlots, heavySlots: f.heavySlots, offloadKinds: f.kinds,
    workspace: f.workspace.trim(), projectPaths: parsePaths(f.paths),
})

export function Nodes() {
    const utils = api.useUtils()
    const meta = api.nodeOps.meta.useQuery()
    const list = api.nodeOps.list.useQuery(undefined, { refetchInterval: 4000 })
    const panelUsers = api.nodeOps.users.panelUsers.useQuery()
    const [form, setForm] = useState<Form | null>(null)
    const [token, setToken] = useState<{ name: string; token: string } | null>(null)
    const done = () => void utils.nodeOps.invalidate()
    const create = api.nodeOps.create.useMutation({ onSuccess: (r, v) => { setToken({ name: v.name, token: r.token }); setForm(null); done() } })
    const update = api.nodeOps.update.useMutation({ onSuccess: () => { setForm(null); done() } })
    const remove = api.nodeOps.remove.useMutation({ onSuccess: done })
    const rotate = api.nodeOps.rotateToken.useMutation({ onSuccess: (r, v) => { setToken({ name: list.data?.find((n) => n.id === v.id)?.name ?? '', token: r.token }); done() } })
    const detect = api.nodeOps.detect.useMutation({ onSuccess: (specs) => { setForm((f) => f && { ...f, cpuModel: specs.cpu?.model ?? f.cpuModel, cores: specs.cpu?.cores ?? f.cores, threads: specs.cpu?.threads ?? f.threads, ramGb: specs.ram?.gb ?? f.ramGb, gpu: (specs.gpu ?? []).join('; ') }); done() } })
    const assign = api.nodeOps.users.assign.useMutation({ onSuccess: done })
    const unassign = api.nodeOps.users.unassign.useMutation({ onSuccess: done })
    const mkUser = api.nodeOps.users.createOnNode.useMutation({ onSuccess: done })
    const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => f && { ...f, [k]: v })
    const save = () => {
        if (!form) return
        const { id } = form
        const base = { name: form.name, type: form.type as 'planet' | 'station', host: form.host, port: form.port, tls: form.tls, notes: form.notes, specs: specsOf(form) }
        if (id) update.mutate({ id, ...base }); else create.mutate(base)
    }
    const err = create.error ?? update.error ?? remove.error ?? detect.error ?? mkUser.error ?? assign.error
    return (
        <Page title="Nodes" actions={<button className="btn-primary btn" onClick={() => setForm({ ...blank })}>Add node</button>}
            sub={<>Machines that run work for the panel. A <b>Planet</b> is the machine the panel and the agents live on; a <b>Station</b> only takes offloaded jobs (builds, suites, GPU and browser runs). Install a daemon with <code className="font-mono">install/install-node.sh --station</code> and paste its token here.</>}>
            <Err e={err} />
            {token && (
                <div className="my-3 rounded border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[12px]">
                    Token for <b>{token.name}</b> (shown once; run the daemon with <code className="font-mono">NIGHTLY_NODE_TOKEN</code> set to it): <code className="select-all break-all font-mono">{token.token}</code>
                    <button className="btn ml-2" onClick={() => setToken(null)}>Dismiss</button>
                </div>
            )}
            {form && (
                <div className="my-3 rounded-lg border border-line p-3">
                    <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
                        <Field label="Name"><input className="input" value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
                        <Field label="Type"><select className="select" value={form.type} onChange={(e) => set('type', e.target.value)}>{meta.data?.types.map((t) => <option key={t}>{t}</option>)}</select></Field>
                        <Field label="Host"><input className="input" value={form.host} placeholder="box.example.net" onChange={(e) => set('host', e.target.value)} /></Field>
                        <Field label="Port"><input className="input" type="number" value={form.port} onChange={(e) => set('port', Number(e.target.value))} /></Field>
                        <Field label="CPU model" wide><input className="input" value={form.cpuModel} onChange={(e) => set('cpuModel', e.target.value)} /></Field>
                        <Field label="Cores"><input className="input" type="number" value={form.cores} onChange={(e) => set('cores', Number(e.target.value))} /></Field>
                        <Field label="Threads"><input className="input" type="number" value={form.threads} onChange={(e) => set('threads', Number(e.target.value))} /></Field>
                        <Field label="RAM (GB)"><input className="input" type="number" value={form.ramGb} onChange={(e) => set('ramGb', Number(e.target.value))} /></Field>
                        <Field label="GPUs (; separated)" wide><input className="input" value={form.gpu} onChange={(e) => set('gpu', e.target.value)} /></Field>
                        <Field label="Build slots"><input className="input" type="number" min={0} value={form.buildSlots} onChange={(e) => set('buildSlots', Number(e.target.value))} /></Field>
                        <Field label="Heavy slots"><input className="input" type="number" min={0} value={form.heavySlots} onChange={(e) => set('heavySlots', Number(e.target.value))} /></Field>
                        <Field label="Offload kinds" wide>
                            <div className="flex flex-wrap gap-3 text-[12px]">
                                {meta.data?.kinds.map((k) => (
                                    <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={form.kinds.includes(k)} onChange={(e) => set('kinds', e.target.checked ? [...form.kinds, k] : form.kinds.filter((x) => x !== k))} />{k}</label>
                                ))}
                            </div>
                        </Field>
                        <Field label="Workspace root on the node" wide><input className="input font-mono" value={form.workspace} placeholder="/home/build/work" title="Jobs for a project run in <workspace>/<repo folder name> unless a project path below says otherwise" onChange={(e) => set('workspace', e.target.value)} /></Field>
                        <Field label="Project paths (slug=/path; …)" wide><input className="input font-mono" value={form.paths} placeholder="fc-game=/srv/fc-game" title="Where each project's checkout lives on this node; wins over the workspace root" onChange={(e) => set('paths', e.target.value)} /></Field>
                        <label className="flex items-center gap-1 text-[12px]"><input type="checkbox" checked={form.tls} onChange={(e) => set('tls', e.target.checked)} />TLS</label>
                        <Field label="Notes" wide><input className="input" value={form.notes} onChange={(e) => set('notes', e.target.value)} /></Field>
                    </div>
                    <div className="mt-3 flex gap-2">
                        <button className="btn-primary btn" onClick={save} disabled={!form.name}>Save</button>
                        {form.id && <button className="btn" onClick={() => detect.mutate({ id: form.id! })} disabled={detect.isPending}>Auto-detect specs</button>}
                        <button className="btn" onClick={() => setForm(null)}>Cancel</button>
                    </div>
                </div>
            )}
            {list.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
            {list.data?.length === 0 && <Empty>No nodes yet. Add one, or run <code className="font-mono">nightly node discover</code>.</Empty>}
            <div className="space-y-2">
                {list.data?.map((n) => (
                    <div key={n.id} className="rounded-lg border border-line px-3 py-2.5">
                        <div className="flex items-center gap-2">
                            <Dot state={n.state} />
                            <span className="font-medium">{n.name}</span>
                            <span className="rounded bg-hover px-1.5 text-[10px] uppercase text-muted">{n.type}</span>
                            <span className="text-[12px] text-muted">{n.host}:{n.port}{n.tls ? ' (tls)' : ''}</span>
                            {n.error && n.state !== 'online' && <span className="truncate text-[11px] text-red-300" title={n.error}>{n.error}</span>}
                            <span className="flex-1" />
                            {n.slots && <span className="text-[11px] tabular-nums text-muted">build {n.slots.build?.used}/{n.slots.build?.max} · heavy {n.slots.heavy?.used}/{n.slots.heavy?.max}</span>}
                            <button className="btn" onClick={() => setForm(toForm(n))}>Edit</button>
                            <button className="btn" onClick={() => rotate.mutate({ id: n.id })}>New token</button>
                            <button className="btn" onClick={() => confirm(`Delete node ${n.name}?`) && remove.mutate({ id: n.id })}>Delete</button>
                        </div>
                        <div className="mt-1 text-[12px] text-muted">
                            {n.specs.cpu?.model ?? 'CPU unknown'} · {n.specs.cpu?.threads ?? '?'} threads · {n.specs.ram?.gb ?? '?'} GB{(n.specs.gpu ?? []).length ? ` · ${(n.specs.gpu ?? []).join(', ')}` : ''}
                            <span className="ml-2">offers: {(n.specs.offloadKinds ?? []).join(', ') || 'nothing'}</span>
                            {n.specs.workspace && <span className="ml-2">workspace: <code className="font-mono">{n.specs.workspace}</code></span>}
                            {Object.keys(n.specs.projectPaths ?? {}).length > 0 && <span className="ml-2">{Object.keys(n.specs.projectPaths ?? {}).length} project path(s)</span>}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                            <span className="label">Users</span>
                            {n.users.map((u) => (
                                <span key={u.id} className="inline-flex items-center gap-1 rounded bg-hover px-1.5">
                                    {u.user} as {u.osUser}
                                    <button className="text-muted hover:text-fg" title="remove" onClick={() => unassign.mutate({ nodeId: n.id, userId: u.userId })}>×</button>
                                </span>
                            ))}
                            <select className="select" value="" onChange={(e) => { const u = panelUsers.data?.find((x) => x.id === Number(e.target.value)); if (u) assign.mutate({ nodeId: n.id, userId: u.id, osUser: u.username.toLowerCase().replace(/[^a-z0-9_-]/g, '_') }) }}>
                                <option value="">assign panel user…</option>
                                {panelUsers.data?.filter((u) => !n.users.some((x) => x.userId === u.id)).map((u) => <option key={u.id} value={u.id}>{u.username}</option>)}
                            </select>
                            <button className="btn" disabled={n.state !== 'online' || mkUser.isPending} title="Create the OS user (and an SSH key) on the node" onClick={() => {
                                const username = prompt('OS username to create on ' + n.name)
                                if (username) mkUser.mutate({ nodeId: n.id, username, generateKey: true })
                            }}>Create user on node</button>
                        </div>
                    </div>
                ))}
            </div>
            {mkUser.data?.publicKey && <pre className="mt-3 overflow-x-auto rounded border border-line p-2 text-[11px]">{mkUser.data.publicKey}</pre>}
        </Page>
    )
}
