'use client'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api } from '~/trpc/react'
import { Composer, DEFAULT_OPTS, type Opts } from './Composer'

export function NewChat() {
    const router = useRouter()
    const places = api.transcripts.places.useQuery()
    const [cwd, setCwd] = useState('')
    const [opts, setOpts] = useState<Opts>(DEFAULT_OPTS)
    const [err, setErr] = useState('')
    const start = api.transcripts.start.useMutation({ onError: (e) => setErr(e.message), onSuccess: (r) => router.push(`/transcripts/${r.transcriptId}`) })
    useEffect(() => { if (!cwd && places.data) setCwd(places.data.projects[0]?.path ?? places.data.recent[0] ?? '') }, [places.data, cwd])
    const p = places.data
    return (
        <div className="flex h-full flex-col">
            <div className="min-h-0 flex-1 overflow-auto">
                <div className="mx-auto max-w-2xl px-4 py-10">
                    <h1 className="mb-1 text-lg font-semibold">New conversation</h1>
                    <p className="mb-6 text-[13px] text-dim">Runs Claude Code as {p?.osUser ?? 'your node user'} in the directory below.</p>
                    <label className="label">Directory</label>
                    <input className="input mb-2 w-full font-mono text-[12px]" list="places" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/home/…/repo" />
                    <datalist id="places">{[...(p?.projects.map((x) => x.path) ?? []), ...(p?.recent ?? [])].map((x) => <option key={x} value={x} />)}</datalist>
                    <div className="mb-4 flex flex-wrap gap-1.5">{p?.projects.slice(0, 12).map((x) => <button key={x.slug} className="btn !py-0.5 text-[11px]" onClick={() => setCwd(x.path)}>{x.name}</button>)}</div>
                    {err && <div className="rounded-md border border-red-500/30 bg-red-500/10 p-2 text-[12px] text-red-200">{err}</div>}
                    {p && !p.canRun && <div className="text-[12px] text-amber-300">You need transcripts.run and node access to start conversations.</div>}
                </div>
            </div>
            <Composer opts={opts} setOpts={setOpts} disabled={start.isPending || !cwd || !p?.canRun} placeholder="What should Claude do?"
                onSend={async (prompt) => { setErr(''); await start.mutateAsync({ prompt, cwd, model: opts.model || undefined, effort: (opts.effort || undefined) as never, mode: opts.mode as never }) }} />
        </div>
    )
}
