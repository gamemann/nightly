'use client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { clearDraft, readDraft, writeDraft } from '~/lib/drafts'
import { api } from '~/trpc/react'
import { Markdown } from './Markdown'
import { MarkdownEditor } from './MarkdownEditor'
import { ago, fmt } from './pills'
import { Pagination, useUrlParams } from './Pagination'
import { ListControls } from './DataTable'
import { parsePage } from '~/lib/paging'
import { PROMPT_SPEC } from '~/lib/feedSpecs'

export function Prompts(props: { name?: string; kind?: 'prompt' | 'script' }) { return <Suspense><PromptsInner {...props} /></Suspense> }

function PromptsInner({ name, kind = 'prompt' }: { name?: string; kind?: 'prompt' | 'script' }) {
    const base = kind === 'script' ? '/jobs' : '/prompts'
    const noun = kind === 'script' ? 'Jobs / Scripts' : 'Prompts'
    const router = useRouter()
    const utils = api.useUtils()
    const { sp } = useUrlParams('l')
    const lq = parsePage(sp, PROMPT_SPEC, 'l')
    const list = api.prompt.page.useQuery({ kind, page: lq.page, size: lq.size, sort: lq.sort, dir: lq.dir, q: lq.q || undefined, f: {} }, { placeholderData: (p) => p })
    const keepQs = sp.toString() ? `?${sp.toString()}` : ''
    const create = api.prompt.save.useMutation({
        onSuccess: (p) => { void utils.prompt.page.invalidate(); router.push(`${base}/${encodeURIComponent(p.name)}`) },
    })
    const rows = list.data?.rows ?? []
    useEffect(() => {
        if (!name && rows.length && !lq.q && lq.page === 1) router.replace(`${base}/${encodeURIComponent(rows[0].name)}`)
    }, [name, rows, router, base, lq.q, lq.page])
    const add = () => {
        const n = prompt(kind === 'script' ? 'Name of the new job (e.g. check.sh)' : 'Name of the new prompt (e.g. deploy.md)')?.trim()
        if (n) create.mutate({ name: n, kind, body: kind === 'script' ? '#!/usr/bin/env bash\n' : `# ${n.replace(/\.md$/, '')}\n\n` })
    }
    return (
        <div className="mx-auto flex max-w-7xl gap-5 px-6 py-5 max-lg:flex-col max-md:px-3">
            <aside className="w-56 shrink-0 max-lg:w-full">
                <div className="mb-2 flex items-center justify-between">
                    <h1 className="text-[15px] font-semibold tracking-tight">{noun}</h1>
                    <button className="btn" onClick={add} disabled={create.isPending}>+ New</button>
                </div>
                <p className="mb-3 text-[12px] text-muted">{kind === 'script'
                    ? 'Runnable jobs: a schedule runs one as a script, no agent involved. Exit 0 = ok, 1 = findings, anything else = failed.'
                    : 'What the agent runs are told. Agents read them with'} {kind === 'prompt' && <code className="font-mono">nightly prompt show</code>}</p>
                {create.error && <p className="mb-2 text-[12px] text-red-300">{create.error.message}</p>}
                <ListControls ns="l" q={lq.q} searchHint="Search name or text" sort={lq.sort} dir={lq.dir} sorts={[{ key: 'name', label: 'name' }, { key: 'updatedAt', label: 'last saved' }]} />
                <nav className="mb-1 flex flex-col gap-0.5">
                    {rows.map((p) => (
                        <Link key={p.id} href={`${base}/${encodeURIComponent(p.name)}${keepQs}`}
                            className={`flex items-center gap-2 rounded-md px-2 py-1.5 ${p.name === name ? 'bg-hover text-fg' : 'text-dim hover:bg-hover/60 hover:text-fg'}`}>
                            <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{p.name}</span>
                            {p.codeLike && <span className="rounded bg-violet-400/15 px-1 text-[10px] text-violet-300" title="Starts with #!: this is a script">script</span>}
                            {p.usedBy.length > 0 && <span className="rounded bg-accent/15 px-1 text-[10px] text-accent" title={`Schedule: ${p.usedBy.join(', ')}`}>◷</span>}
                        </Link>
                    ))}
                </nav>
                {list.data && <Pagination p={list.data} ns="l" />}
            </aside>
            <main className="min-w-0 flex-1">
                {name ? <PromptEditor key={name} name={name} base={base} /> : rows.length === 0 && <div className="rounded-lg border border-line p-10 text-center text-muted">Nothing here yet.</div>}
            </main>
        </div>
    )
}

function PromptEditor({ name, base: root }: { name: string; base: string }) {
    const router = useRouter()
    const utils = api.useUtils()
    const q = api.prompt.get.useQuery({ name }, { refetchOnWindowFocus: true })
    const p = q.data
    const draftId = `prompt:${name}`
    const [text, setText] = useState<string | null>(null)
    const [base, setBase] = useState('')
    const [note, setNote] = useState('')
    const [preview, setPreview] = useState(false)
    const [viewing, setViewing] = useState<number | null>(null)
    const version = api.prompt.version.useQuery({ id: viewing ?? 0 }, { enabled: viewing !== null })

    // First load: the stored body, or the unsaved draft left from before.
    useEffect(() => {
        if (!p || text !== null) return
        const d = readDraft(draftId)
        setText(d ? d.text : p.body)
        setBase(d ? d.base : p.body)
    }, [p, text, draftId])
    // A refetch that brings a newer body is taken over silently only when nothing is being edited.
    useEffect(() => {
        if (p && text !== null && text === base && p.body !== base) { setText(p.body); setBase(p.body) }
    }, [p, text, base])

    const invalidate = () => Promise.all([utils.prompt.get.invalidate({ name }), utils.prompt.page.invalidate()])
    const save = api.prompt.save.useMutation({
        onSuccess: async (r) => { clearDraft(draftId); setBase(r.body); setText(r.body); setNote(''); await invalidate() },
    })
    const del = api.prompt.delete.useMutation({ onSuccess: async () => { await Promise.all([utils.prompt.page.invalidate()]); router.push(root) } })

    const dirty = text !== null && text !== base
    const changedElsewhere = !!p && p.body !== base
    const doSave = (force = false) => text !== null && dirty && save.mutate({ name, body: text, base: force ? undefined : base, note })
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); doSave() }
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    })

    if (q.isLoading) return <div className="p-10 text-muted">Loading…</div>
    if (!p) return <div className="p-10 text-muted">No prompt {name}.</div>
    const isMd = p.kind === 'prompt'
    return (
        <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <h2 className="font-mono text-[16px] font-semibold">{p.name}</h2>
                <span className="text-[11px] text-muted">{p.kind} · saved {ago(p.updatedAt)}</span>
                {dirty && <span className="rounded bg-amber-400/15 px-1.5 text-[11px] text-amber-300">unsaved</span>}
                <div className="ml-auto flex items-center gap-2">
                    {isMd && <button className="btn" onClick={() => setPreview(!preview)}>{preview ? 'Edit' : 'Preview'}</button>}
                    <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="what changed (optional)" className="input w-56 max-md:w-36"
                        onKeyDown={(e) => e.key === 'Enter' && doSave()} />
                    <button className="btn-primary" disabled={!dirty || save.isPending} onClick={() => doSave()} title="Ctrl+S">Save</button>
                </div>
            </div>
            {!isMd && <JobPanel name={name} />}
            {changedElsewhere && dirty && (
                <div className="mb-2 flex flex-wrap items-center gap-3 rounded-md border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-[12px] text-amber-200">
                    Saved elsewhere since you started editing (the nightly run or another tab).
                    <button className="btn" onClick={() => { setText(p.body); setBase(p.body); clearDraft(draftId) }}>Discard mine, load theirs</button>
                    <button className="btn" onClick={() => doSave(true)}>Overwrite with mine</button>
                </div>
            )}
            {save.error && <p className="mb-2 text-[12px] text-red-300">{save.error.message}</p>}
            {preview && isMd ? (
                <div className="rounded-lg border border-line bg-panel/30 px-5 py-4"><Markdown>{text ?? ''}</Markdown></div>
            ) : (
                <MarkdownEditor value={text ?? ''} spellCheck={isMd}
                    onValueChange={(v) => { setText(v); writeDraft(draftId, v, base) }}
                    className="input min-h-[65vh] w-full font-mono text-[12.5px] leading-relaxed" />
            )}
            <div className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-4 max-lg:grid-cols-1">
                <section>
                    <span className="label">History · {p.versions.length}</span>
                    <ul className="mt-2 max-h-80 overflow-y-auto rounded-lg border border-line bg-panel/40">
                        {p.versions.map((v, i) => (
                            <li key={v.id}>
                                <button onClick={() => setViewing(viewing === v.id ? null : v.id)}
                                    className={`flex w-full items-baseline gap-2 border-b border-line/60 px-3 py-1.5 text-left text-[12px] last:border-0 hover:bg-hover/50 ${viewing === v.id ? 'bg-hover' : ''}`}>
                                    <span className="w-36 shrink-0 whitespace-nowrap text-muted">{fmt(v.createdAt)}</span>
                                    <span className="w-14 shrink-0 text-dim">{v.author}</span>
                                    <span className="min-w-0 flex-1 truncate text-fg/80">{i === 0 ? <span className="text-emerald-300">current · </span> : null}{v.note}</span>
                                </button>
                            </li>
                        ))}
                    </ul>
                    <button className="btn mt-3 hover:!border-red-400/40 hover:!text-red-300" disabled={del.isPending}
                        onClick={() => confirm(`Delete ${p.name} and its history?`) && del.mutate({ name })}>Delete prompt</button>
                    {del.error && <p className="mt-1 text-[12px] text-red-300">{del.error.message}</p>}
                </section>
                {viewing !== null && version.data && (
                    <section>
                        <div className="flex items-center gap-2">
                            <span className="label">Version of {fmt(version.data.createdAt)}</span>
                            <button className="btn ml-auto" onClick={() => { setText(version.data.body); writeDraft(draftId, version.data.body, base); setViewing(null) }}>
                                Load into editor
                            </button>
                        </div>
                        <pre className="mt-2 max-h-80 overflow-auto rounded-lg border border-line bg-panel/40 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap text-dim">{version.data.body}</pre>
                    </section>
                )}
            </div>
        </div>
    )
}

const EXIT_MEANING: [string, string][] = [['0', 'ok: nothing to report'], ['1', 'findings: the check ran and found problems (amber, raises RSI findings)'], ['other', 'failed: the job itself broke (infra, timeout, bad setup)']]

/** Last run, linked schedules, the exit-code contract and a Run now button for one job script. */
function JobPanel({ name }: { name: string }) {
    const utils = api.useUtils()
    const q = api.prompt.job.useQuery({ name }, { refetchInterval: 10_000 })
    const run = api.schedule.start.useMutation({ onSuccess: () => void utils.prompt.job.invalidate({ name }) })
    const j = q.data
    return (
        <div className="mb-3 rounded-lg border border-line bg-panel/40 px-3 py-2 text-[12px]" data-testid="job-panel">
            <div className="flex flex-wrap items-center gap-3">
                <span className="rounded bg-violet-400/15 px-1.5 text-violet-300">script</span>
                <span className="text-dim">Last run: {j?.lastRun ? <Link className="text-accent" href={`/runs/${j.lastRun.id}`}>#{j.lastRun.id} {j.lastRun.status} · {ago(j.lastRun.startedAt)}</Link> : 'never'}</span>
                <span className="text-dim">Schedule: {j?.schedules.length ? j.schedules.map((s) => s.name).join(', ') : 'none'}</span>
                <button className="btn-primary ml-auto" disabled={!j?.schedules.length || run.isPending}
                    title={j?.schedules.length ? 'Run it now, ignoring the clock' : 'Attach it to a schedule first'}
                    onClick={() => j && run.mutate({ id: j.schedules[0].id })}>Run now</button>
            </div>
            {run.error && <p className="mt-1 text-red-300">{run.error.message}</p>}
            <ul className="mt-1.5 flex flex-wrap gap-x-5 gap-y-0.5 text-muted">
                {EXIT_MEANING.map(([c, m]) => <li key={c}><code className="font-mono text-fg/80">exit {c}</code> {m}</li>)}
            </ul>
        </div>
    )
}
