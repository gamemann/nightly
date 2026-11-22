'use client'
import Link from 'next/link'
import { useState } from 'react'
import { api } from '~/trpc/react'
import { Pagination, useUrlParams } from './Pagination'
import { parsePage } from '../lib/paging'

const box = 'rounded-md border border-line bg-panel px-2 py-1 text-[12px]'
const btn = 'rounded-md border border-line px-2 py-1 text-[12px] hover:bg-hover'


type Src = { name: string; type: string; root: string; repo: string; enabled: boolean; config: string; lastScanAt: string | null }
type Kind = { key: string; label: string; sort: number; match: string; budget: string }
const parse = (s: string): Record<string, unknown> => { try { return JSON.parse(s) as Record<string, unknown> } catch { return {} } }

/** Settings for the Assets tab: where assets come from (sources) and what each kind is judged against (kinds). */
export function AssetSources() {
    const utils = api.useUtils()
    const sU = useUrlParams('s')
    const kU = useUrlParams('k')
    const sq = parsePage(sU.sp, { sorts: ['name'], sort: '' }, 's')
    const kq = parsePage(kU.sp, { sorts: ['key'], sort: '' }, 'k')
    const sources = api.assets.sources.useQuery(sq, { placeholderData: (p) => p })
    const kinds = api.assets.kinds.useQuery(kq, { placeholderData: (p) => p })
    const [msg, setMsg] = useState('')
    const done = { onSuccess: () => { void utils.assets.invalidate(); setMsg('saved') }, onError: (e: { message: string }) => setMsg(e.message) }
    const add = api.assets.sourceAdd.useMutation(done)
    const upd = api.assets.sourceSet.useMutation(done)
    const rm = api.assets.sourceRm.useMutation(done)
    const scan = api.assets.scan.useMutation({ ...done, onSuccess: (r) => { void utils.assets.invalidate(); setMsg(`scan: ${JSON.stringify(r)}`) } })
    const kSave = api.assets.kindSave.useMutation(done)
    const kRm = api.assets.kindRm.useMutation(done)
    const [n, setN] = useState({ name: '', type: 'pack' as 'pack' | 'game', root: '' })
    return (
        <div className="mx-auto max-w-5xl px-6 py-5 max-md:px-3">
            <div className="mb-1 flex items-baseline justify-between"><h1 className="text-[15px] font-semibold tracking-tight">Asset sources and kinds</h1><Link className="text-[12px] text-sky-300 hover:underline" href="/assets">back to Assets</Link></div>
            <p className="mb-4 text-[12px] text-muted">A source is a directory of models, textures and sounds (an asset pack or a game). Nothing is built in: add yours, scan it, and the Assets tab lists what it finds. The same is available as <code className="font-mono">nightly assets source add|set|rm|scan</code>.</p>
            {msg && <div className="mb-3 rounded-md border border-line bg-panel/60 px-3 py-1.5 text-[12px] text-dim" onClick={() => setMsg('')}>{msg}</div>}
            <h2 className="mb-2 text-[13px] font-semibold">Sources</h2>
            <div className="mb-3 flex flex-wrap gap-2 rounded-lg border border-line p-3">
                <input className={box} placeholder="name" value={n.name} onChange={(e) => setN({ ...n, name: e.target.value })} />
                <select className={box} value={n.type} onChange={(e) => setN({ ...n, type: e.target.value as 'pack' | 'game' })}><option value="pack">pack</option><option value="game">game</option></select>
                <input className={`${box} min-w-64 flex-1`} placeholder="root directory on the server" value={n.root} onChange={(e) => setN({ ...n, root: e.target.value })} />
                <button className={btn} disabled={!n.name || !n.root} onClick={() => add.mutate(n, { onSuccess: () => setN({ ...n, name: '', root: '' }) })}>Add source</button>
            </div>
            {sources.data?.rows.map((s) => <SourceRow key={s.name} s={s as Src} onSave={(p) => upd.mutate({ name: s.name, ...p })} onScan={() => scan.mutate({ names: [s.name] })} onRm={(purge) => rm.mutate({ name: s.name, purge })} />)}
            {sources.data?.rows.length === 0 && <p className="mb-4 text-[12px] text-muted">No sources yet. Add the first one above, for example a game checkout with its models under assets/.</p>}
            {sources.data && <Pagination p={sources.data} ns="s" />}
            {!!sources.data?.rows.length && <button className={`${btn} mb-6 mt-2`} onClick={() => scan.mutate({})}>Scan all enabled</button>}
            <h2 className="mb-2 mt-4 text-[13px] font-semibold">Kinds and budgets</h2>
            <p className="mb-2 text-[12px] text-muted">The kind decides which audit checks and limits apply. <code className="font-mono">match</code> is a regex on the model path; the budget is JSON (min_tris, max_tris, min_tex, max_tex, required_clips, require_skin, max_size, and more).</p>
            {kinds.data?.rows.map((k) => <KindRow key={k.key} k={k as Kind} onSave={(p) => kSave.mutate({ key: k.key, ...p })} onRm={() => kRm.mutate({ key: k.key })} />)}
            {kinds.data && <Pagination p={kinds.data} ns="k" />}
            <NewKind onAdd={(p) => kSave.mutate(p)} />
        </div>
    )
}

function SourceRow({ s, onSave, onScan, onRm }: { s: Src; onSave: (p: { root: string; repo: string; enabled: boolean; config: Record<string, unknown> }) => void; onScan: () => void; onRm: (purge: boolean) => void }) {
    const cfg = parse(s.config)
    const [root, setRoot] = useState(s.root)
    const [repo, setRepo] = useState(s.repo)
    const [conf, setConf] = useState(JSON.stringify(cfg, null, 2))
    const [bad, setBad] = useState('')
    const save = (enabled = s.enabled) => { try { onSave({ root, repo, enabled, config: JSON.parse(conf || '{}') as Record<string, unknown> }); setBad('') } catch (e) { setBad((e as Error).message) } }
    return (
        <details className="mb-2 rounded-lg border border-line">
            <summary className="flex cursor-pointer items-center gap-3 px-3 py-2 text-[13px]">
                <span className="font-medium">{s.name}</span><span className="text-[11px] text-muted">{s.type}</span>
                <span className="truncate font-mono text-[11px] text-dim">{s.root}</span>
                <span className="ml-auto text-[11px] text-muted">{s.enabled ? '' : 'disabled, '}{s.lastScanAt ? `scanned ${s.lastScanAt.slice(0, 16).replace('T', ' ')}` : 'never scanned'}</span>
            </summary>
            <div className="grid gap-2 border-t border-line p-3">
                <label className="text-[12px] text-dim">root <input className={`${box} w-full font-mono`} value={root} onChange={(e) => setRoot(e.target.value)} /></label>
                <label className="text-[12px] text-dim">git repo (optional) <input className={`${box} w-full font-mono`} value={repo} onChange={(e) => setRepo(e.target.value)} /></label>
                <label className="text-[12px] text-dim">config JSON: models, textures, sounds (globs relative to root), exclude, defaultKind, kindRules, soundKinds, soundMatch, weaponDefs, eventTable
                    <textarea className={`${box} h-40 w-full font-mono`} value={conf} onChange={(e) => setConf(e.target.value)} placeholder={'{ "models": ["assets/**/*.glb"], "defaultKind": "prop" }'} /></label>
                {bad && <p className="text-[12px] text-red-300">{bad}</p>}
                <div className="flex gap-2">
                    <button className={btn} onClick={() => save()}>Save</button>
                    <button className={btn} onClick={() => save(!s.enabled)}>{s.enabled ? 'Disable' : 'Enable'}</button>
                    <button className={btn} onClick={onScan}>Scan</button>
                    <button className={`${btn} ml-auto text-red-300`} onClick={() => confirm(`Remove ${s.name}? Its asset rows stay.`) && onRm(false)}>Remove</button>
                    <button className={`${btn} text-red-300`} onClick={() => confirm(`Remove ${s.name} and delete its asset rows?`) && onRm(true)}>Remove and purge</button>
                </div>
            </div>
        </details>
    )
}

function KindRow({ k, onSave, onRm }: { k: Kind; onSave: (p: { label: string; sort: number; match: string; budget: Record<string, unknown> }) => void; onRm: () => void }) {
    const [label, setLabel] = useState(k.label)
    const [sort, setSort] = useState(String(k.sort))
    const [match, setMatch] = useState(k.match)
    const [budget, setBudget] = useState(JSON.stringify(parse(k.budget)))
    const [bad, setBad] = useState('')
    return (
        <div className="mb-1.5 flex flex-wrap items-start gap-2 rounded-lg border border-line p-2">
            <span className="w-20 pt-1 font-mono text-[12px] text-dim">{k.key}</span>
            <input className={`${box} w-28`} value={label} onChange={(e) => setLabel(e.target.value)} />
            <input className={`${box} w-14`} value={sort} onChange={(e) => setSort(e.target.value)} title="sort order" />
            <input className={`${box} w-40 font-mono`} value={match} onChange={(e) => setMatch(e.target.value)} placeholder="path regex" />
            <textarea className={`${box} h-8 min-w-60 flex-1 font-mono`} value={budget} onChange={(e) => setBudget(e.target.value)} />
            <button className={btn} onClick={() => { try { onSave({ label, sort: Number(sort) || 0, match, budget: JSON.parse(budget || '{}') as Record<string, unknown> }); setBad('') } catch (e) { setBad((e as Error).message) } }}>Save</button>
            <button className={`${btn} text-red-300`} onClick={onRm}>Delete</button>
            {bad && <span className="w-full text-[12px] text-red-300">{bad}</span>}
        </div>
    )
}

function NewKind({ onAdd }: { onAdd: (p: { key: string; label: string }) => void }) {
    const [key, setKey] = useState('')
    return (
        <div className="mt-2 flex gap-2"><input className={box} placeholder="new kind key" value={key} onChange={(e) => setKey(e.target.value.toLowerCase())} />
            <button className={btn} disabled={!/^[\w.-]+$/.test(key)} onClick={() => { onAdd({ key, label: key }); setKey('') }}>Add kind</button></div>
    )
}
