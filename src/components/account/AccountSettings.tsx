'use client'
import { useState } from 'react'
import { can } from '../../../lib/permissions.mjs'
import { Card, ErrorLine, Field, Table, when } from '~/components/shell/form'
import { PageHeader } from '~/components/shell/ui'
import { api } from '~/trpc/react'

/** /account/settings: profile, password, roles and the user's sessions. */
export function AccountSettings() {
    const me = api.account.me.useQuery()
    const mayEdit = can(me.data?.perms, 'account.edit')
    return (
        <div>
            <PageHeader title="Account settings" sub={me.data ? <>Signed in as <span className="font-mono">{me.data.username}</span> · roles: {me.data.roles.join(', ') || 'none'}</> : null} />
            <div className="grid max-w-5xl gap-4 p-6 lg:grid-cols-2">
                {me.data && <Profile name={me.data.name} disabled={!mayEdit} />}
                <Password disabled={!mayEdit} />
                <Sessions />
            </div>
        </div>
    )
}

function Profile({ name: initial, disabled }: { name: string; disabled: boolean }) {
    const utils = api.useUtils()
    const [name, setName] = useState(initial)
    const m = api.account.edit.useMutation({ onSuccess: () => void utils.account.me.invalidate() })
    return (
        <Card title="Profile">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); m.mutate({ name }) }}>
                <Field label="Display name"><input className="input w-64" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} /></Field>
                <button className="btn-primary" disabled={disabled || m.isPending}>Save</button>
                {m.isSuccess && <span className="text-[12px] text-dim">Saved.</span>}
            </form>
            <ErrorLine error={m.error} />
        </Card>
    )
}

function Password({ disabled }: { disabled: boolean }) {
    const utils = api.useUtils()
    const [f, setF] = useState({ current: '', next: '', again: '' })
    const [err, setErr] = useState('')
    const m = api.account.changePassword.useMutation({ onSuccess: () => { setF({ current: '', next: '', again: '' }); void utils.account.sessions.invalidate() } })
    return (
        <Card title="Password">
            <form className="space-y-3" onSubmit={(e) => {
                e.preventDefault()
                if (f.next !== f.again) return setErr('the new passwords differ')
                setErr('')
                m.mutate({ current: f.current, next: f.next })
            }}>
                <Field label="Current password"><input type="password" autoComplete="current-password" className="input w-64" required disabled={disabled} value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} /></Field>
                <Field label="New password"><input type="password" autoComplete="new-password" className="input w-64" required disabled={disabled} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
                <Field label="New password again"><input type="password" autoComplete="new-password" className="input w-64" required disabled={disabled} value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} /></Field>
                <div className="flex items-center gap-3">
                    <button className="btn-primary" disabled={disabled || m.isPending}>Change password</button>
                    {m.isSuccess && <span className="text-[12px] text-dim">Changed. Your other sessions were signed out.</span>}
                </div>
            </form>
            {err && <p className="text-[12px] text-red-400">{err}</p>}
            <ErrorLine error={m.error} />
        </Card>
    )
}

function Sessions() {
    const utils = api.useUtils()
    const q = api.account.sessions.useQuery()
    const others = api.account.logoutOthers.useMutation({ onSuccess: () => void utils.account.sessions.invalidate() })
    return (
        <Card title="Sessions" className="lg:col-span-2" actions={<div className="flex gap-2">
            <button className="btn" disabled={others.isPending || (q.data?.length ?? 0) < 2} onClick={() => others.mutate()}>Sign out other sessions</button>
            <form action="/api/logout" method="post"><button className="btn">Sign out</button></form>
        </div>}>
            <ErrorLine error={q.error ?? others.error} />
            <Table head={['Started', 'Last seen', 'Expires', 'IP', 'Browser', '']}>
                {q.data?.map((s) => (
                    <tr key={s.id}>
                        <td>{when(s.createdAt)}</td><td>{when(s.lastSeenAt)}</td><td>{when(s.expiresAt)}</td><td className="font-mono text-[12px]">{s.ip || '-'}</td>
                        <td className="max-w-xs truncate text-[12px] text-dim" title={s.userAgent}>{s.userAgent || '-'}</td>
                        <td>{s.current && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] text-accent">this one</span>}</td>
                    </tr>
                ))}
            </Table>
        </Card>
    )
}
