'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { CADENCES, KINDS, STATUSES, STATUS_LABEL } from '~/lib/constants'
import { clearDraft, readDraft, writeDraft } from '~/lib/drafts'
import { api } from '~/trpc/react'
import { Markdown } from './Markdown'
import { MarkdownEditor } from './MarkdownEditor'
import { KindTag, RepoChips, StatusPill, ago, fmt } from './pills'

type Patch = Parameters<ReturnType<typeof api.item.update.useMutation>['mutate']>[0]['patch']

export function ItemDetail({ itemKey }: { itemKey: string }) {
    const router = useRouter()
    const utils = api.useUtils()
    const q = api.item.get.useQuery({ key: itemKey })
    const invalidate = () => Promise.all([utils.item.get.invalidate({ key: itemKey }), utils.item.list.invalidate(), utils.item.counts.invalidate()])
    const update = api.item.update.useMutation({
        onSuccess: async (it) => {
            if (it.key !== itemKey) router.replace(`/item/${it.key}`)
            await invalidate()
        },
    })
    const checked = api.item.checked.useMutation({ onSuccess: invalidate })
    const del = api.item.delete.useMutation({ onSuccess: async () => { await invalidate(); router.push('/queue') } })
    // The description is copied from the server ONCE, when editing starts, and never again while it is open.
    // Re-syncing on q.data threw the text away on every refetch -- a window refocus, or any sidebar save, which
    // invalidates this query -- because superjson's Dates defeat react-query's structural sharing and every
    // refetch is a new object even when nothing changed.
    const bodyDraft = `${itemKey}:body`
    const [editing, setEditing] = useState(false)
    const [body, setBody] = useState('')
    const [base, setBase] = useState('')
    const [restored, setRestored] = useState(false)
    const [title, setTitle] = useState('')
    const serverTitle = q.data?.title
    useEffect(() => { if (serverTitle !== undefined) setTitle(serverTitle) }, [serverTitle])
    // An unsaved draft from an earlier visit reopens the editor with it, exactly where it was left.
    const checkedDraft = useRef(false)
    useEffect(() => {
        if (!q.data || checkedDraft.current) return
        checkedDraft.current = true
        const d = readDraft(bodyDraft)
        if (!d) return
        if (d.text === q.data.body) return clearDraft(bodyDraft)
        setBody(d.text); setBase(d.base); setEditing(true); setRestored(true)
    }, [q.data, bodyDraft])

    if (q.isLoading) return <div className="p-10 text-muted">Loading…</div>
    if (!q.data) return <div className="p-10 text-muted">No item “{itemKey}”. <Link className="text-accent" href="/queue">Back to queue</Link></div>
    const it = q.data
    const save = (patch: Patch) => update.mutate({ key: it.key, patch })
    const startEdit = () => { setBody(it.body); setBase(it.body); setRestored(false); setEditing(true) }
    const editBody = (v: string) => { setBody(v); writeDraft(bodyDraft, v, base) }
    // The draft is dropped only once the server has the text; a failed save leaves both the editor and the draft.
    const saveBody = () => update.mutate({ key: it.key, patch: { body } }, {
        onSuccess: () => { clearDraft(bodyDraft); setEditing(false); setRestored(false) },
    })
    const cancelEdit = () => {
        if (body !== it.body && !confirm('Discard your unsaved changes to the description?')) return
        clearDraft(bodyDraft); setEditing(false); setRestored(false)
    }

    return (
        <div className="mx-auto flex max-w-6xl gap-8 px-6 py-5 max-lg:flex-col max-md:px-3">
            <div className="min-w-0 flex-1">
                <div className="mb-3 flex items-center gap-2 text-[12px] text-muted">
                    <button onClick={() => router.back()} className="hover:text-fg">←</button>
                    <span className="font-mono">{it.key}</span>
                    <StatusPill status={it.status} />
                    <KindTag kind={it.kind} />
                </div>
                <input value={title} onChange={(e) => setTitle(e.target.value)}
                    onBlur={() => title.trim() && title !== it.title && save({ title })}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                    className="w-full rounded-md bg-transparent px-1 -mx-1 text-[20px] font-semibold tracking-tight outline-none hover:bg-hover/40 focus:bg-panel-2" />
                {it.doneWhen && (
                    <div className="mt-3 rounded-md border border-emerald-400/15 bg-emerald-400/5 px-3 py-2 text-[12.5px]">
                        <span className="label mr-2 text-emerald-300/80">Done when</span>{it.doneWhen}
                    </div>
                )}
                <section className="mt-5">
                    <div className="mb-2 flex items-center justify-between">
                        <span className="label">Description</span>
                        {editing ? (
                            <span className="flex gap-2">
                                <button className="btn" onClick={cancelEdit}>Cancel</button>
                                <button className="btn-primary" disabled={update.isPending} onClick={saveBody}>{update.isPending ? 'Saving…' : 'Save'}</button>
                            </span>
                        ) : (
                            <button className="btn" onClick={startEdit}>Edit</button>
                        )}
                    </div>
                    {editing ? (
                        <>
                            {restored && <p className="mb-2 text-[11.5px] text-amber-300/90">Restored your unsaved draft.</p>}
                            {base !== it.body && (
                                <p className="mb-2 text-[11.5px] text-red-300/90">The description has changed since you started editing — saving replaces it.</p>
                            )}
                            <MarkdownEditor value={body} onValueChange={editBody} autoFocus
                                onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveBody() } }}
                                className="input min-h-[420px] w-full font-mono text-[12.5px] leading-relaxed" />
                            <p className="mt-1 text-[11px] text-muted">
                                {body !== it.body ? 'Draft kept in this browser until saved · ' : ''}Tab indents · Shift+Tab outdents · Ctrl+B/I · Ctrl+Enter saves · Esc leaves the box
                            </p>
                        </>
                    ) : it.body.trim() ? (
                        <div onDoubleClick={startEdit}><Markdown>{it.body}</Markdown></div>
                    ) : (
                        <button onClick={startEdit} className="w-full rounded-md border border-dashed border-line p-6 text-muted hover:border-line-strong">Add a description…</button>
                    )}
                </section>
                <Notes itemKey={it.key} notes={it.notes} onAdded={invalidate} />
            </div>

            <aside className="w-72 shrink-0 space-y-4 max-lg:w-full">
                <div className="space-y-3 rounded-lg border border-line bg-panel/60 p-4">
                    <Field label="Status">
                        <select className="select w-full" value={it.status} onChange={(e) => save({ status: e.target.value as (typeof STATUSES)[number] })}>
                            {STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
                        </select>
                    </Field>
                    <Field label="Kind">
                        <select className="select w-full" value={it.kind} onChange={(e) => save({ kind: e.target.value as (typeof KINDS)[number] })}>
                            {KINDS.map((k) => <option key={k}>{k}</option>)}
                        </select>
                    </Field>
                    {it.kind === 'check' && (
                        <Field label="Cadence">
                            <div className="flex items-center gap-2">
                                <select className="select flex-1" value={it.cadence ?? 'nightly'} onChange={(e) => save({ cadence: e.target.value as (typeof CADENCES)[number] })}>
                                    {CADENCES.map((c) => <option key={c}>{c}</option>)}
                                </select>
                                <button className="btn" onClick={() => checked.mutate({ key: it.key })} title="Stamp lastRunAt now">Mark run</button>
                            </div>
                            <p className="mt-1 text-[11px] text-muted">Last run {ago(it.lastRunAt)}{it.due && <span className="text-teal-300"> · due</span>}</p>
                        </Field>
                    )}
                    <TextField label="Repos" value={it.repos} placeholder="a, b" onSave={(repos) => save({ repos })} />
                    <div className="-mt-1"><RepoChips repos={it.repos} max={20} /></div>
                    <TextField label="Done when" value={it.doneWhen ?? ''} multiline onSave={(v) => save({ doneWhen: v || null })} />
                    <TextField label="Key" value={it.key} mono onSave={(v) => v && save({ newKey: v })} />
                    {update.error && <p className="text-[11px] text-red-400">{update.error.message}</p>}
                </div>
                <dl className="space-y-1.5 rounded-lg border border-line bg-panel/60 p-4 text-[12px]">
                    <Meta k="Added" v={`${fmt(it.createdAt)} · ${it.addedBy}`} />
                    <Meta k="Updated" v={ago(it.updatedAt)} />
                    {it.completedAt && <Meta k="Completed" v={fmt(it.completedAt)} />}
                    <Meta k="Priority" v={String(it.priority)} />
                </dl>
                <button className="text-[11px] text-muted hover:text-red-400"
                    onClick={() => confirm(`Delete ${it.key} and its notes? (Prefer "Won't fix" -- it keeps history.)`) && del.mutate({ key: it.key })}>
                    Delete item
                </button>
            </aside>
        </div>
    )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
    return <label className="block"><span className="label mb-1 block">{label}</span>{children}</label>
}

function Meta({ k, v }: { k: string; v: string }) {
    return <div className="flex justify-between gap-3"><dt className="text-muted">{k}</dt><dd className="text-right text-dim">{v}</dd></div>
}

function TextField(p: { label: string; value: string; onSave: (v: string) => void; placeholder?: string; multiline?: boolean; mono?: boolean }) {
    const [v, setV] = useState(p.value)
    useEffect(() => setV(p.value), [p.value])
    const commit = () => v.trim() !== p.value && p.onSave(v.trim())
    const cls = `input w-full ${p.mono ? 'font-mono text-[12px]' : ''}`
    return (
        <Field label={p.label}>
            {p.multiline ? (
                <textarea className={`${cls} min-h-16`} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} placeholder={p.placeholder} />
            ) : (
                <input className={cls} value={v} onChange={(e) => setV(e.target.value)} onBlur={commit} placeholder={p.placeholder}
                    onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
            )}
        </Field>
    )
}

type NoteT = { id: number; author: string; body: string; createdAt: Date; run: { id: number; startedAt: Date } | null }

function Notes({ itemKey, notes, onAdded }: { itemKey: string; notes: NoteT[]; onAdded: () => unknown }) {
    const draftId = `${itemKey}:note`
    const [text, setText] = useState(() => readDraft(draftId)?.text ?? '')
    const edit = (v: string) => { setText(v); writeDraft(draftId, v, '') }
    const add = api.note.add.useMutation({ onSuccess: async () => { setText(''); clearDraft(draftId); await onAdded() } })
    const del = api.note.delete.useMutation({ onSuccess: onAdded })
    const submit = () => text.trim() && add.mutate({ key: itemKey, body: text })
    return (
        <section className="mt-8">
            <span className="label">Notes · {notes.length}</span>
            <ol className="relative mt-3 space-y-4 border-l border-line pl-5">
                {notes.map((n) => (
                    <li key={n.id} className="group relative">
                        <span className={`absolute top-1.5 -left-[25px] size-2.5 rounded-full ring-4 ring-bg ${n.author === 'nightly' ? 'bg-accent' : 'bg-zinc-500'}`} />
                        <div className="mb-1 flex items-center gap-2 text-[11.5px] text-muted">
                            <span className="font-medium text-dim">{n.author}</span>
                            <span>{fmt(n.createdAt)}</span>
                            {n.run && <Link href={`/runs/${n.run.id}`} className="rounded bg-accent/10 px-1.5 text-accent hover:bg-accent/20">run #{n.run.id}</Link>}
                            <button onClick={() => confirm('Delete this note?') && del.mutate({ id: n.id })} className="ml-auto opacity-0 hover:text-red-400 group-hover:opacity-100">delete</button>
                        </div>
                        <div className="rounded-lg border border-line bg-panel/50 px-3.5 py-2.5"><Markdown>{n.body}</Markdown></div>
                    </li>
                ))}
                <li className="relative">
                    <span className="absolute top-2 -left-[25px] size-2.5 rounded-full bg-line-strong ring-4 ring-bg" />
                    <MarkdownEditor value={text} onValueChange={edit} placeholder="Add a note (markdown) · Ctrl+Enter"
                        onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() } }}
                        className="input min-h-20 w-full" />
                    <div className="mt-2 flex items-center justify-end gap-3">
                        {text.trim() && <span className="text-[11px] text-muted">Draft kept in this browser until added</span>}
                        <button className="btn-primary" disabled={!text.trim() || add.isPending} onClick={submit}>Add note</button>
                    </div>
                </li>
            </ol>
        </section>
    )
}
