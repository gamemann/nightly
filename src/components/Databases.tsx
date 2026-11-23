'use client'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { Empty, Err, Field, Page } from './nodes/ui'

const blank = { name: '', kind: 'clickhouse', host: 'localhost', port: 8123, database: '', username: '', secretRef: '' }

export function Databases() {
    const utils = api.useUtils()
    const meta = api.nodeOps.meta.useQuery()
    const list = api.nodeOps.databases.list.useQuery()
    const [f, setF] = useState<(typeof blank & { id?: number }) | null>(null)
    const [found, setFound] = useState<string | null>(null)
    const done = () => void utils.nodeOps.databases.invalidate()
    const save = api.nodeOps.databases.save.useMutation({ onSuccess: () => { setF(null); done() } })
    const remove = api.nodeOps.databases.remove.useMutation({ onSuccess: done })
    const detect = api.nodeOps.databases.detect.useMutation({ onSuccess: (r) => { setFound(`${r.created.length} added${r.created.length ? ` (${r.created.join(', ')})` : ''}, ${r.existing.length} already known`); done() } })
    return (
        <Page title="Databases" actions={<><button className="btn" disabled={detect.isPending} onClick={() => detect.mutate()}>Detect from Docker Compose</button><button className="btn-primary btn" onClick={() => setF({ ...blank })}>Add</button></>}
            sub="Database servers the panel uses (usage analytics live in ClickHouse). Detection reads docker-compose files and .env next to the panel and each project. Passwords are never stored here: the secret reference names the env var, e.g. NIGHTLY_CLICKHOUSE_PASSWORD.">
            <Err e={save.error ?? remove.error ?? detect.error} />
            {found && <div className="my-2 text-[12px] text-teal-300">{found}</div>}
            {f && (
                <div className="my-3 rounded-lg border border-line p-3">
                    <div className="grid grid-cols-4 gap-3 max-md:grid-cols-2">
                        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
                        <Field label="Kind"><select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{meta.data?.dbKinds.map((k) => <option key={k}>{k}</option>)}</select></Field>
                        <Field label="Host"><input className="input" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} /></Field>
                        <Field label="Port"><input className="input" type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} /></Field>
                        <Field label="Database"><input className="input" value={f.database} onChange={(e) => setF({ ...f, database: e.target.value })} /></Field>
                        <Field label="User"><input className="input" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
                        <Field label="Secret reference" wide><input className="input" value={f.secretRef} placeholder="NIGHTLY_CLICKHOUSE_PASSWORD" onChange={(e) => setF({ ...f, secretRef: e.target.value })} /></Field>
                    </div>
                    <div className="mt-3 flex gap-2">
                        <button className="btn-primary btn" disabled={!f.name} onClick={() => save.mutate(f)}>Save</button>
                        <button className="btn" onClick={() => setF(null)}>Cancel</button>
                    </div>
                </div>
            )}
            {list.data?.length === 0 && <Empty>No database connections yet.</Empty>}
            <div className="space-y-2">
                {list.data?.map((d) => (
                    <div key={d.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2.5">
                        <span className="font-medium">{d.name}</span>
                        <span className="rounded bg-hover px-1.5 text-[10px] uppercase text-muted">{d.kind}</span>
                        <span className="text-[12px] text-muted">{d.host}:{d.port} {d.database && `/ ${d.database}`} {d.username && `as ${d.username}`}</span>
                        {d.secretRef && <span className="font-mono text-[11px] text-muted">{d.secretRef}</span>}
                        <span className="flex-1" />
                        <button className="btn" onClick={() => setF({ id: d.id, name: d.name, kind: d.kind, host: d.host, port: d.port, database: d.database, username: d.username, secretRef: d.secretRef })}>Edit</button>
                        <button className="btn" onClick={() => confirm(`Delete ${d.name}?`) && remove.mutate({ id: d.id })}>Delete</button>
                    </div>
                ))}
            </div>
        </Page>
    )
}
