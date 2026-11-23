'use client'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { Dot, Empty, Err, Field, Page } from './nodes/ui'

const LINK_COLOR: Record<string, string> = { ok: 'text-teal-300', failed: 'text-red-300', unknown: 'text-muted' }

export function Communication() {
    const utils = api.useUtils()
    const meta = api.nodeOps.meta.useQuery()
    const g = api.nodeOps.links.graph.useQuery(undefined, { refetchInterval: 4000 })
    const [f, setF] = useState({ fromId: 0, toId: 0, username: '', auth: 'ssh-key', password: '', sshPort: 22 })
    const done = () => void utils.nodeOps.links.invalidate()
    const connect = api.nodeOps.links.connect.useMutation({ onSuccess: () => { setF((x) => ({ ...x, password: '' })); done() } })
    const auto = api.nodeOps.links.auto.useMutation({ onSuccess: done })
    const remove = api.nodeOps.links.remove.useMutation({ onSuccess: done })
    const nodes = g.data?.nodes ?? []
    const link = (a: number, b: number) => g.data?.links.find((l) => l.fromId === a && l.toId === b)
    const ready = f.fromId && f.toId && f.username
    const R = 130, cx = 180, cy = 160
    const pos = (i: number) => ({ x: cx + R * Math.cos((2 * Math.PI * i) / Math.max(nodes.length, 1) - Math.PI / 2), y: cy + R * Math.sin((2 * Math.PI * i) / Math.max(nodes.length, 1) - Math.PI / 2) })
    return (
        <Page title="Communication" sub="How the nodes reach each other. A link means the from-node can ssh to the to-node as the given user, so jobs and files can move between them. The panel itself talks to every node over its daemon connection (green dot).">
            <Err e={connect.error ?? auto.error ?? remove.error} />
            {nodes.length === 0 ? <Empty>No nodes yet. Add some on the Nodes page.</Empty> : (
                <div className="grid grid-cols-[360px_1fr] gap-4 max-md:grid-cols-1">
                    <svg viewBox="0 0 360 320" className="w-full rounded-lg border border-line">
                        {g.data?.links.map((l) => {
                            const a = nodes.findIndex((n) => n.id === l.fromId), b = nodes.findIndex((n) => n.id === l.toId)
                            if (a < 0 || b < 0) return null
                            const p = pos(a), q = pos(b)
                            return <line key={l.id} x1={p.x} y1={p.y} x2={q.x} y2={q.y} strokeWidth={1.5} className={l.status === 'ok' ? 'stroke-teal-400' : l.status === 'failed' ? 'stroke-red-400' : 'stroke-zinc-500'} strokeDasharray={l.status === 'ok' ? '' : '4 3'} />
                        })}
                        {nodes.map((n, i) => {
                            const p = pos(i)
                            return (
                                <g key={n.id}>
                                    <circle cx={p.x} cy={p.y} r={n.type === 'planet' ? 16 : 11} className={`${n.state === 'online' ? 'fill-teal-400/30 stroke-teal-400' : 'fill-zinc-700/40 stroke-zinc-500'}`} />
                                    <text x={p.x} y={p.y + (n.type === 'planet' ? 28 : 24)} textAnchor="middle" className="fill-current text-[10px]">{n.name}</text>
                                </g>
                            )
                        })}
                    </svg>
                    <div className="overflow-x-auto">
                        <table className="w-full text-[12px]">
                            <thead><tr><th className="p-1.5 text-left label">from \ to</th>{nodes.map((n) => <th key={n.id} className="p-1.5 text-left font-medium"><Dot state={n.state} /> {n.name}</th>)}</tr></thead>
                            <tbody>
                                {nodes.map((a) => (
                                    <tr key={a.id} className="border-t border-line">
                                        <td className="p-1.5 font-medium"><Dot state={a.state} /> {a.name}</td>
                                        {nodes.map((b) => {
                                            const l = link(a.id, b.id)
                                            return (
                                                <td key={b.id} className="p-1.5">
                                                    {a.id === b.id ? <span className="text-muted">-</span> : l ? (
                                                        <span className={LINK_COLOR[l.status] ?? ''}>{l.status} <span className="text-muted">({l.username}, {l.auth})</span> <button className="text-muted hover:text-fg" onClick={() => remove.mutate({ id: l.id })}>×</button></span>
                                                    ) : <button className="text-muted hover:text-fg" onClick={() => setF((x) => ({ ...x, fromId: a.id, toId: b.id }))}>connect</button>}
                                                </td>
                                            )
                                        })}
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>
            )}
            <div className="mt-4 rounded-lg border border-line p-3">
                <div className="label mb-2">Connect</div>
                <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
                    <Field label="From"><select className="select" value={f.fromId} onChange={(e) => setF({ ...f, fromId: Number(e.target.value) })}><option value={0}>choose</option>{nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field>
                    <Field label="To"><select className="select" value={f.toId} onChange={(e) => setF({ ...f, toId: Number(e.target.value) })}><option value={0}>choose</option>{nodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></Field>
                    <Field label="User on the target"><input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
                    <Field label="SSH port"><input className="input" type="number" value={f.sshPort} onChange={(e) => setF({ ...f, sshPort: Number(e.target.value) })} /></Field>
                    <Field label="Auth"><select className="select" value={f.auth} onChange={(e) => setF({ ...f, auth: e.target.value })}>{meta.data?.linkAuth.map((a) => <option key={a}>{a}</option>)}</select></Field>
                    {f.auth === 'password' && <Field label="Password (used once, never stored)"><input className="input" type="password" autoComplete="off" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>}
                </div>
                <div className="mt-3 flex gap-2">
                    <button className="btn-primary btn" disabled={!ready || connect.isPending} onClick={() => connect.mutate({ fromId: f.fromId, toId: f.toId, username: f.username, auth: f.auth as 'ssh-key' | 'password', password: f.password || undefined, sshPort: f.sshPort })}>Connect</button>
                    <button className="btn" disabled={!ready || auto.isPending} title="Create the user on the target if missing, generate a key on the source and authorize it" onClick={() => auto.mutate({ fromId: f.fromId, toId: f.toId, username: f.username, sshPort: f.sshPort })}>Auto-connect</button>
                </div>
            </div>
        </Page>
    )
}
