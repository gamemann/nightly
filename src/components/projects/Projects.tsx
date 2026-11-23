'use client'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'
import { can, flattenTree } from '../../../lib/permissions.mjs'
import { PROJECT_TYPES } from '../../../lib/projects-core.mjs'
import { Card, ErrorLine, Field } from '~/components/shell/form'
import { PageHeader } from '~/components/shell/ui'
import { api } from '~/trpc/react'
import { ProjectIcon } from './ProjectIcon'

const TYPE_LABEL: Record<string, string> = { game: 'Game', 'game-addon': 'Game addon', website: 'Website' }

/** /projects: the folder tree on the left, the filtered project list on the right. */
export function Projects() {
    const sp = useSearchParams()
    const router = useRouter()
    const folderId = sp.get('folder') ? Number(sp.get('folder')) : undefined
    const type = sp.get('type') ?? undefined
    const [q, setQ] = useState('')
    const [archived, setArchived] = useState(false)
    const [adding, setAdding] = useState<'' | 'project' | 'folder'>('')
    const me = api.account.me.useQuery()
    const tree = api.folder.tree.useQuery()
    const list = api.project.list.useQuery({ q: q || undefined, type: (PROJECT_TYPES as string[]).includes(type ?? '') ? type ?? undefined : undefined, folderId, deep: true, archived, sort: 'sort' })
    const counts = api.project.counts.useQuery()
    const flat = flattenTree(tree.data ?? [])
    const mayCreate = can(me.data?.perms, 'projects.create')
    const setParam = (k: string, v?: string) => {
        const u = new URLSearchParams(sp.toString())
        if (v) u.set(k, v)
        else u.delete(k)
        router.replace(`/projects${u.size ? `?${u}` : ''}`)
    }

    return (
        <div>
            <PageHeader title="Projects" sub="Games, addons and websites, grouped in folders."
                actions={mayCreate && <>
                    <button className="btn" onClick={() => setAdding(adding === 'folder' ? '' : 'folder')}>New folder</button>
                    <button className="btn-primary" onClick={() => setAdding(adding === 'project' ? '' : 'project')}>New project</button>
                </>} />
            <div className="grid gap-5 p-6 lg:grid-cols-[14rem_1fr]">
                <aside className="space-y-0.5 text-[13px]">
                    <button onClick={() => setParam('folder')} className={`block w-full rounded px-2 py-1 text-left ${folderId == null ? 'nav-active' : 'text-dim hover:bg-hover/60'}`}>All folders</button>
                    {flat.map(({ folder, depth }) => (
                        <button key={folder.id} onClick={() => setParam('folder', String(folder.id))} style={{ paddingLeft: 8 + depth * 14 }}
                            className={`block w-full truncate rounded py-1 pr-2 text-left ${folderId === folder.id ? 'nav-active' : 'text-dim hover:bg-hover/60'}`}>▸ {folder.name}{counts.data?.folders[folder.id] ? <span className="ml-1 text-[11px] text-muted" title="distinct tasks / assets / maps in this folder and below">{counts.data.folders[folder.id].tasks}/{counts.data.folders[folder.id].assets}/{counts.data.folders[folder.id].maps}</span> : null}</button>
                    ))}
                    {!flat.length && !tree.isLoading && <p className="px-2 py-1 text-[12px] text-muted">No folders yet.</p>}
                </aside>
                <div className="min-w-0 space-y-4">
                    {adding === 'folder' && <NewFolder folders={flat.map((f) => ({ id: f.folder.id, label: f.path.join(' / ') }))} parentId={folderId} done={() => setAdding('')} />}
                    {adding === 'project' && <NewProject folders={flat.map((f) => ({ id: f.folder.id, label: f.path.join(' / ') }))} folderId={folderId} done={() => setAdding('')} />}
                    <div className="flex flex-wrap items-center gap-2">
                        <input className="input w-56" placeholder="Search projects" value={q} onChange={(e) => setQ(e.target.value)} />
                        <select className="select" value={type ?? ''} onChange={(e) => setParam('type', e.target.value || undefined)}>
                            <option value="">All types</option>
                            {PROJECT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}
                        </select>
                        <label className="flex items-center gap-1.5 text-[12px] text-dim"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> archived</label>
                        <span className="ml-auto text-[12px] text-muted">{list.data?.length ?? 0} projects</span>
                    </div>
                    <ErrorLine error={list.error} />
                    {list.data && !list.data.length && <p className="glow-card p-6 text-center text-[13px] text-dim">No projects match.</p>}
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                        {list.data?.map((p) => (
                            <Link key={p.id} href={`/projects/${p.slug}`} className="glow-card flex items-center gap-3 p-3 transition hover:border-accent/50">
                                <ProjectIcon p={p} />
                                <div className="min-w-0">
                                    <div className="truncate text-[13.5px] font-medium">{p.name}{p.archived && <span className="ml-1.5 text-[11px] text-muted">archived</span>}</div>
                                    <div className="truncate text-[11.5px] text-muted">{TYPE_LABEL[p.type] ?? p.type}{p.folder ? ` · ${p.folder.name}` : ''} · {p.slug}</div>
                                    {counts.data?.projects[p.id] && <Counts c={counts.data.projects[p.id]} />}
                                </div>
                            </Link>
                        ))}
                    </div>
                </div>
            </div>
        </div>
    )
}

export function Counts({ c }: { c: { tasks: number; open: number; assets: number; maps: number } }) {
    return <div className="truncate text-[11.5px] text-dim">{c.tasks} tasks ({c.open} open) · {c.assets} assets · {c.maps} maps</div>
}

type FolderOpt = { id: number; label: string }

function NewFolder({ folders, parentId, done }: { folders: FolderOpt[]; parentId?: number; done: () => void }) {
    const utils = api.useUtils()
    const [name, setName] = useState('')
    const [parent, setParent] = useState(parentId ?? 0)
    const m = api.folder.create.useMutation({ onSuccess: () => { void utils.folder.invalidate(); done() } })
    return (
        <Card title="New folder">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); m.mutate({ name, parentId: parent || null }) }}>
                <Field label="Name"><input className="input w-56" required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
                <Field label="Inside">
                    <select className="select" value={parent} onChange={(e) => setParent(Number(e.target.value))}>
                        <option value={0}>(top level)</option>
                        {folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
                    </select>
                </Field>
                <button className="btn-primary" disabled={m.isPending}>Create</button>
            </form>
            <ErrorLine error={m.error} />
        </Card>
    )
}

function NewProject({ folders, folderId, done }: { folders: FolderOpt[]; folderId?: number; done: () => void }) {
    const utils = api.useUtils()
    const router = useRouter()
    const [f, setF] = useState({ slug: '', name: '', type: 'game', repoPath: '', repoUrl: '', folderId: folderId ?? 0 })
    const m = api.project.create.useMutation({ onSuccess: (p) => { void utils.project.invalidate(); done(); router.push(`/projects/${p.slug}`) } })
    const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === 'folderId' ? Number(e.target.value) : e.target.value })
    return (
        <Card title="New project">
            <form className="grid gap-3 sm:grid-cols-3" onSubmit={(e) => { e.preventDefault(); m.mutate({ ...f, folderId: f.folderId || null }) }}>
                <Field label="Name"><input className="input w-full" required value={f.name} onChange={set('name')} autoFocus /></Field>
                <Field label="Slug" hint="a-z 0-9 . _ -"><input className="input w-full" required value={f.slug} onChange={set('slug')} /></Field>
                <Field label="Type">
                    <select className="select w-full" value={f.type} onChange={set('type')}>{PROJECT_TYPES.map((t) => <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>)}</select>
                </Field>
                <Field label="Folder">
                    <select className="select w-full" value={f.folderId} onChange={set('folderId')}>
                        <option value={0}>(none)</option>
                        {folders.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                </Field>
                <Field label="Repository path"><input className="input w-full" value={f.repoPath} onChange={set('repoPath')} /></Field>
                <Field label="Repository URL"><input className="input w-full" value={f.repoUrl} onChange={set('repoUrl')} /></Field>
                <div className="sm:col-span-3 flex items-center gap-3">
                    <button className="btn-primary" disabled={m.isPending}>Create project</button>
                    <ErrorLine error={m.error} />
                </div>
            </form>
        </Card>
    )
}
