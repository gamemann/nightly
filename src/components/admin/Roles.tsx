'use client'
import { useState } from 'react'
import { Card, ErrorLine, Field } from '~/components/shell/form'
import { PageHeader } from '~/components/shell/ui'
import { api } from '~/trpc/react'

// AdminCP > Roles: each role is a set of permission grants. Tick single permissions, or add
// patterns (`tools.*`, `*`) in the extra box. The builtin roles cannot be deleted; admin keeps `*`.

type R = { id: number; name: string; description: string; builtin: boolean; grants: { perm: string }[]; _count: { users: number } }

export function AdminRoles() {
    const q = api.role.list.useQuery()
    const [open, setOpen] = useState<number | 'new' | null>(null)
    return (
        <div>
            <PageHeader title="Roles" sub="Permission sets given to users." actions={<button className="btn-primary" onClick={() => setOpen(open === 'new' ? null : 'new')}>New role</button>} />
            <div className="space-y-4 p-6">
                <ErrorLine error={q.error} />
                {open === 'new' && <RoleForm done={() => setOpen(null)} />}
                {q.data?.map((r) => (
                    <Card key={r.id} title={<>{r.name}{r.builtin && <span className="ml-2 text-[11px] font-normal text-muted">builtin</span>}<span className="ml-2 text-[11px] font-normal text-muted">{r._count.users} users</span></>}
                        actions={<button className="btn" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Close' : 'Edit'}</button>}>
                        {open === r.id ? <RoleForm role={r} done={() => setOpen(null)} /> : (
                            <>
                                {r.description && <p className="mb-2 text-[13px] text-dim">{r.description}</p>}
                                <div className="flex flex-wrap gap-1">{r.grants.map((g) => <code key={g.perm} className="rounded bg-panel-2 px-1.5 py-0.5 text-[11.5px]">{g.perm}</code>)}</div>
                            </>
                        )}
                    </Card>
                ))}
            </div>
        </div>
    )
}

function RoleForm({ role, done }: { role?: R; done: () => void }) {
    const utils = api.useUtils()
    const perms = api.account.permissions.useQuery()
    const keys = new Set(perms.data?.map((p) => p.key))
    const start = role?.grants.map((g) => g.perm) ?? []
    const [name, setName] = useState(role?.name ?? '')
    const [description, setDescription] = useState(role?.description ?? '')
    const [picked, setPicked] = useState(start)
    const [extra, setExtra] = useState('')
    const ok = () => { void utils.role.list.invalidate(); done() }
    const create = api.role.create.useMutation({ onSuccess: ok })
    const edit = api.role.edit.useMutation({ onSuccess: ok })
    const del = api.role.delete.useMutation({ onSuccess: ok })
    const patterns = picked.filter((p) => !keys.has(p))
    const grants = () => [...new Set([...picked, ...extra.split(/[\s,]+/).filter(Boolean)])]
    const areas = [...new Set(perms.data?.map((p) => p.area))]
    return (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); role ? edit.mutate({ id: role.id, description, grants: grants() }) : create.mutate({ name, description, grants: grants() }) }}>
            <div className="grid gap-3 sm:grid-cols-2">
                {!role && <Field label="Name"><input className="input w-full" required value={name} onChange={(e) => setName(e.target.value)} /></Field>}
                <Field label="Description"><input className="input w-full" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {areas.map((a) => (
                    <fieldset key={a} className="rounded-lg border border-line/60 p-2">
                        <legend className="px-1 text-[11px] uppercase tracking-wide text-muted">{a}</legend>
                        {perms.data?.filter((p) => p.area === a).map((p) => (
                            <label key={p.key} className="flex items-start gap-1.5 py-0.5 text-[12.5px]" title={p.label}>
                                <input type="checkbox" className="mt-0.5" checked={picked.includes(p.key)} onChange={(e) => setPicked(e.target.checked ? [...picked, p.key] : picked.filter((x) => x !== p.key))} />
                                <span><span className="font-mono">{p.key}</span> <span className="text-muted">{p.label}</span></span>
                            </label>
                        ))}
                    </fieldset>
                ))}
            </div>
            {patterns.length > 0 && (
                <div className="flex flex-wrap items-center gap-1 text-[12px]"><span className="text-muted">Patterns:</span>
                    {patterns.map((p) => <button type="button" key={p} className="rounded bg-panel-2 px-1.5 py-0.5 font-mono hover:line-through" title="remove" onClick={() => setPicked(picked.filter((x) => x !== p))}>{p}</button>)}
                </div>
            )}
            <Field label="Add patterns" hint="Space or comma separated, e.g. tools.* or *"><input className="input w-72 font-mono" value={extra} onChange={(e) => setExtra(e.target.value)} /></Field>
            <div className="flex flex-wrap items-center gap-2">
                <button className="btn-primary" disabled={create.isPending || edit.isPending}>{role ? 'Save' : 'Create role'}</button>
                {role && !role.builtin && <button type="button" className="btn ml-auto text-red-400" onClick={() => confirm(`Delete role ${role.name}?`) && del.mutate({ id: role.id })}>Delete</button>}
            </div>
            <ErrorLine error={create.error ?? edit.error ?? del.error} />
        </form>
    )
}
