'use client'
import { useRouter } from 'next/navigation'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { can, flattenTree } from '../../../lib/permissions.mjs'
import { PROJECT_TYPES } from '../../../lib/projects-core.mjs'
import { Card, ErrorLine, Field, Table, when } from '~/components/shell/form'
import { api } from '~/trpc/react'
import { ProjectIcon } from './ProjectIcon'

// The client halves of /projects/[slug]: the overview (with the edit form for editors), project
// settings (icon) and the builds list. Phase 2+ tabs render their own components from the page.

export function ProjectOverview({ slug }: { slug: string }) {
    const q = api.project.get.useQuery({ slug })
    const me = api.account.me.useQuery()
    const [editing, setEditing] = useState(false)
    const p = q.data
    if (!p) return <div className="p-6"><ErrorLine error={q.error} /></div>
    const rows: [string, ReactNode][] = [
        ['Type', p.type], ['Folder', p.folder?.name ?? '-'], ['Repository path', p.repoPath || '-'],
        ['Repository URL', p.repoUrl ? <a className="text-accent hover:underline" href={p.repoUrl} target="_blank" rel="noreferrer">{p.repoUrl}</a> : '-'],
        ['Settings', Object.keys(p.settings).length ? <code className="text-[12px]">{JSON.stringify(p.settings)}</code> : '-'],
        ['Created', when(p.createdAt)], ['Updated', when(p.updatedAt)],
    ]
    return (
        <div className="max-w-3xl space-y-4 p-6">
            <Card title="Project" actions={p.canEdit && <button className="btn" onClick={() => setEditing(!editing)}>{editing ? 'Close' : 'Edit'}</button>}>
                {editing ? <EditProject p={p} mayDelete={can(me.data?.perms, 'projects.delete')} done={() => setEditing(false)} /> : (
                    <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-[13px]">
                        {rows.map(([k, val]) => <Fragment key={k}><dt className="text-muted">{k}</dt><dd className="min-w-0 break-words">{val}</dd></Fragment>)}
                    </dl>
                )}
            </Card>
        </div>
    )
}

type P = { id: number; slug: string; name: string; type: string; repoPath: string; repoUrl: string; folderId: number | null; archived: boolean; settings: Record<string, unknown> }

function EditProject({ p, mayDelete, done }: { p: P; mayDelete: boolean; done: () => void }) {
    const utils = api.useUtils()
    const router = useRouter()
    const tree = api.folder.tree.useQuery()
    const [f, setF] = useState({ name: p.name, slug: p.slug, type: p.type, repoPath: p.repoPath, repoUrl: p.repoUrl, folderId: p.folderId ?? 0, archived: p.archived, settings: JSON.stringify(p.settings, null, 2) })
    const [jsonErr, setJsonErr] = useState('')
    const edit = api.project.edit.useMutation({
        onSuccess: (r) => { void utils.project.invalidate(); done(); if (r.slug !== p.slug) router.replace(`/projects/${r.slug}`); else router.refresh() },
    })
    const del = api.project.delete.useMutation({ onSuccess: () => { void utils.project.invalidate(); router.push('/projects') } })
    const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === 'folderId' ? Number(e.target.value) : e.target.value })
    const save = () => {
        let settings: Record<string, unknown>
        try { settings = JSON.parse(f.settings || '{}') } catch { return setJsonErr('settings: not valid JSON') }
        setJsonErr('')
        edit.mutate({ id: p.id, name: f.name, slug: f.slug, type: f.type, repoPath: f.repoPath, repoUrl: f.repoUrl, folderId: f.folderId || null, archived: f.archived, settings })
    }
    return (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save() }}>
            <Field label="Name"><input className="input w-full" required value={f.name} onChange={set('name')} /></Field>
            <Field label="Slug"><input className="input w-full" required value={f.slug} onChange={set('slug')} /></Field>
            <Field label="Type"><select className="select w-full" value={f.type} onChange={set('type')}>{PROJECT_TYPES.map((t) => <option key={t}>{t}</option>)}</select></Field>
            <Field label="Folder">
                <select className="select w-full" value={f.folderId} onChange={set('folderId')}>
                    <option value={0}>(none)</option>
                    {flattenTree(tree.data ?? []).map(({ folder, path }) => <option key={folder.id} value={folder.id}>{path.join(' / ')}</option>)}
                </select>
            </Field>
            <Field label="Repository path"><input className="input w-full" value={f.repoPath} onChange={set('repoPath')} /></Field>
            <Field label="Repository URL"><input className="input w-full" value={f.repoUrl} onChange={set('repoUrl')} /></Field>
            <Field label="Settings (JSON)" hint='e.g. {"perfGame": "fc"} points the Perf tab at another perf slug' className="sm:col-span-2">
                <textarea className="input h-24 w-full font-mono text-[12px]" value={f.settings} onChange={set('settings')} />
            </Field>
            <label className="flex items-center gap-2 text-[13px]"><input type="checkbox" checked={f.archived} onChange={(e) => setF({ ...f, archived: e.target.checked })} /> Archived</label>
            <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
                <button className="btn-primary" disabled={edit.isPending}>Save</button>
                {mayDelete && <button type="button" className="btn ml-auto text-red-400" onClick={() => confirm(`Delete project ${p.slug}? Tasks and perf data stay.`) && del.mutate({ id: p.id })}>Delete project</button>}
            </div>
            <div className="sm:col-span-2">{jsonErr && <p className="text-[12px] text-red-400">{jsonErr}</p>}<ErrorLine error={edit.error ?? del.error} /></div>
        </form>
    )
}

/** Settings tab: the icon (upload, replace, remove). */
export function ProjectSettings({ slug }: { slug: string }) {
    const q = api.project.get.useQuery({ slug })
    const utils = api.useUtils()
    const router = useRouter()
    const file = useRef<HTMLInputElement>(null)
    const [msg, setMsg] = useState('')
    const [busy, setBusy] = useState(false)
    useEffect(() => setMsg(''), [slug])
    const send = async (method: 'POST' | 'DELETE', body?: FormData) => {
        setBusy(true)
        const r = await fetch(`/api/projects/${encodeURIComponent(slug)}/icon`, { method, body })
        const j = (await r.json().catch(() => ({}))) as { error?: string }
        setBusy(false)
        setMsg(r.ok ? (method === 'POST' ? 'Icon saved.' : 'Icon removed.') : (j.error ?? `failed (${r.status})`))
        if (r.ok) { void utils.project.invalidate(); router.refresh() }
    }
    const p = q.data
    if (!p) return <div className="p-6"><ErrorLine error={q.error} /></div>
    return (
        <div className="max-w-3xl space-y-4 p-6">
            <Card title="Icon">
                <div className="flex flex-wrap items-center gap-4">
                    <ProjectIcon p={p} size="size-16" />
                    <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); const f = file.current?.files?.[0]; if (f) { const fd = new FormData(); fd.set('file', f); void send('POST', fd) } }}>
                        <input ref={file} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="text-[12px] text-dim file:btn file:mr-2" required />
                        <button className="btn-primary" disabled={busy}>Upload</button>
                        {p.icon && <button type="button" className="btn" disabled={busy} onClick={() => void send('DELETE')}>Remove</button>}
                    </form>
                </div>
                <p className="mt-2 text-[11.5px] text-muted">PNG, JPEG, GIF or WebP, up to 512 KB. Square images look best.</p>
                {msg && <p className="mt-1 text-[12px] text-dim">{msg}</p>}
            </Card>
        </div>
    )
}

/** Builds tab: this project's build configs (admins edit them under AdminCP > Builds). */
export function ProjectBuilds({ projectId }: { projectId: number }) {
    const q = api.buildConfig.list.useQuery({ projectId })
    return (
        <div className="max-w-4xl space-y-4 p-6">
            <Card title="Build configs" actions={<a className="btn" href={"/admin/builds"}>Edit in AdminCP</a>}>
                <ErrorLine error={q.error} />
                {q.data && !q.data.length && <p className="text-[13px] text-dim">No build configs yet.</p>}
                {!!q.data?.length && (
                    <Table head={['Name', 'Command', 'Heavy', 'Offload to', 'Timeout', 'Enabled']}>
                        {q.data.map((b) => (
                            <tr key={b.id}>
                                <td className="font-mono">{b.name}</td><td className="max-w-md truncate font-mono text-[12px]">{b.command || '-'}</td>
                                <td>{b.heavy ? 'yes' : '-'}</td><td>{b.nodeKinds || '-'}</td><td>{b.timeout ? `${b.timeout}s` : 'none'}</td><td>{b.enabled ? 'yes' : 'no'}</td>
                            </tr>
                        ))}
                    </Table>
                )}
            </Card>
        </div>
    )
}
