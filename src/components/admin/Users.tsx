'use client'
import { useState } from 'react'
import { Card, ErrorLine, Field, Table, when } from '~/components/shell/form'
import { PageHeader } from '~/components/shell/ui'
import { api } from '~/trpc/react'

// AdminCP > Users: create, edit (name, password, roles, per-user grants), disable, delete.
// Per-user grants are written one per line: `perm` allows, `!perm` denies (patterns like tools.*).

type U = { id: number; username: string; name: string; disabledAt: Date | null; lastLoginAt: Date | null; roles: { role: { id: number; name: string } }[]; grants: { perm: string; allow: boolean }[]; _count: { sessions: number } }

export function AdminUsers() {
    const q = api.user.list.useQuery()
    const roles = api.role.list.useQuery()
    const me = api.account.me.useQuery()
    const [open, setOpen] = useState<number | 'new' | null>(null)
    const roleNames = roles.data?.map((r) => r.name) ?? []
    return (
        <div>
            <PageHeader title="Users" sub="Accounts that can sign in to this panel." actions={<button className="btn-primary" onClick={() => setOpen(open === 'new' ? null : 'new')}>New user</button>} />
            <div className="space-y-4 p-6">
                {open === 'new' && <NewUser roles={roleNames} done={() => setOpen(null)} />}
                <ErrorLine error={q.error} />
                <div className="glow-card p-3">
                    <Table head={['User', 'Name', 'Roles', 'Grants', 'Last sign-in', 'Sessions', 'Status', '']}>
                        {q.data?.map((u) => (
                            <tr key={u.id} className={u.disabledAt ? 'opacity-60' : undefined}>
                                <td className="font-mono">{u.username}{u.id === me.data?.id && <span className="ml-1 text-[11px] text-muted">(you)</span>}</td>
                                <td>{u.name || '-'}</td>
                                <td>{u.roles.map((r) => r.role.name).join(', ') || '-'}</td>
                                <td className="text-[12px] text-dim">{u.grants.map((g) => (g.allow ? g.perm : `!${g.perm}`)).join(', ') || '-'}</td>
                                <td className="whitespace-nowrap">{when(u.lastLoginAt)}</td>
                                <td className="tabular-nums">{u._count.sessions}</td>
                                <td>{u.disabledAt ? 'disabled' : 'active'}</td>
                                <td><button className="btn" onClick={() => setOpen(open === u.id ? null : u.id)}>{open === u.id ? 'Close' : 'Edit'}</button></td>
                            </tr>
                        ))}
                    </Table>
                </div>
                {typeof open === 'number' && q.data?.find((u) => u.id === open) && <EditUser key={open} u={q.data.find((u) => u.id === open)!} roles={roleNames} self={open === me.data?.id} done={() => setOpen(null)} />}
            </div>
        </div>
    )
}

function RolePicker({ all, value, onChange }: { all: string[]; value: string[]; onChange: (v: string[]) => void }) {
    return (
        <div className="flex flex-wrap gap-3 text-[13px]">
            {all.map((r) => (
                <label key={r} className="flex items-center gap-1.5">
                    <input type="checkbox" checked={value.includes(r)} onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))} /> {r}
                </label>
            ))}
        </div>
    )
}

function NewUser({ roles, done }: { roles: string[]; done: () => void }) {
    const utils = api.useUtils()
    const [f, setF] = useState({ username: '', name: '', password: '', roles: ['user'] })
    const m = api.user.create.useMutation({ onSuccess: () => { void utils.user.list.invalidate(); done() } })
    return (
        <Card title="New user">
            <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); m.mutate(f) }}>
                <Field label="Username"><input className="input w-full" required autoComplete="off" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
                <Field label="Name"><input className="input w-full" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
                <Field label="Password"><input type="password" autoComplete="new-password" className="input w-full" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
                <div className="sm:col-span-3"><span className="label">Roles</span><RolePicker all={roles} value={f.roles} onChange={(r) => setF({ ...f, roles: r })} /></div>
                <div className="flex items-center gap-3 sm:col-span-3"><button className="btn-primary" disabled={m.isPending}>Create user</button><ErrorLine error={m.error} /></div>
            </form>
        </Card>
    )
}

function EditUser({ u, roles, self, done }: { u: U; roles: string[]; self: boolean; done: () => void }) {
    const utils = api.useUtils()
    const [f, setF] = useState({ name: u.name, password: '', roles: u.roles.map((r) => r.role.name), grants: u.grants.map((g) => (g.allow ? g.perm : `!${g.perm}`)).join('\n') })
    const ok = () => { void utils.user.list.invalidate(); done() }
    const edit = api.user.edit.useMutation({ onSuccess: ok })
    const del = api.user.delete.useMutation({ onSuccess: ok })
    const grants = f.grants.split(/[\n,]/).map((s) => s.trim()).filter(Boolean).map((s) => (s.startsWith('!') ? { perm: s.slice(1), allow: false } : { perm: s, allow: true }))
    return (
        <Card title={<>Edit <span className="font-mono">{u.username}</span></>}>
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); edit.mutate({ id: u.id, name: f.name, roles: f.roles, grants, ...(f.password ? { password: f.password } : {}) }) }}>
                <Field label="Name"><input className="input w-full" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
                <Field label="New password" hint="Leave empty to keep it. A new password signs the user out everywhere."><input type="password" autoComplete="new-password" className="input w-full" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
                <div className="sm:col-span-2"><span className="label">Roles</span><RolePicker all={roles} value={f.roles} onChange={(r) => setF({ ...f, roles: r })} /></div>
                <Field label="Extra grants" hint="One per line: tools.run allows, !usage.view denies; patterns like tools.* work." className="sm:col-span-2">
                    <textarea className="input h-20 w-full font-mono text-[12px]" value={f.grants} onChange={(e) => setF({ ...f, grants: e.target.value })} />
                </Field>
                <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                    <button className="btn-primary" disabled={edit.isPending}>Save</button>
                    {!self && <button type="button" className="btn" onClick={() => edit.mutate({ id: u.id, disabled: !u.disabledAt })}>{u.disabledAt ? 'Enable' : 'Disable'}</button>}
                    {!self && <button type="button" className="btn ml-auto text-red-400" onClick={() => confirm(`Delete user ${u.username}?`) && del.mutate({ id: u.id })}>Delete</button>}
                </div>
                <div className="sm:col-span-2"><ErrorLine error={edit.error ?? del.error} /></div>
            </form>
        </Card>
    )
}
