"use client"
import { useRouter } from "next/navigation"
import { useMemo, useState } from "react"
import { Metrics, Stage, Viewer, type MediaGroup, type MediaItem } from "./MediaViewer"
import type { ReviewMedia, ReviewWeapon } from "../../lib/review.mjs"

type Review = { key: string; title: string; body: string; createdAt: string; weapons: Record<string, ReviewWeapon> }
const url = (key: string, file: string) => `/reviewmedia/${encodeURIComponent(key)}/${file.split("/").map(encodeURIComponent).join("/")}`
const VERDICT: Record<string, { label: string; cls: string }> = {
    good: { label: "good", cls: "bg-emerald-400/15 text-emerald-300" },
    wrong: { label: "still wrong", cls: "bg-red-400/15 text-red-300" },
    "": { label: "not reviewed", cls: "bg-hover text-dim" },
}

export function Reviews({ reviews }: { reviews: Review[] }) {
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">Reviews</h1>
            <p className="mt-0.5 mb-4 text-[12px] text-muted">Per-weapon animation (filmstrips and looping clips, before and after) and audio (waveform, licence), each with a good / still-wrong verdict and a note that builders read back with <code className="font-mono">nightly review open KEY</code>.</p>
            {reviews.length === 0 && <div className="mb-6 rounded-lg border border-line px-3 py-6 text-center text-muted">No reviews yet. File one (see below).</div>}
            <div className="space-y-6">{reviews.map((r) => <ReviewCard key={r.key} r={r} />)}</div>
            <Docs />
        </div>
    )
}

function ReviewCard({ r }: { r: Review }) {
    const ids = Object.keys(r.weapons).sort()
    const count = (v: string) => ids.filter((i) => r.weapons[i].verdict === v).length
    return (
        <section className="rounded-lg border border-line">
            <header className="flex flex-wrap items-baseline gap-3 border-b border-line px-4 py-2.5">
                <h2 className="text-[13px] font-semibold">{r.title}</h2>
                <code className="font-mono text-[11px] text-muted">{r.key}</code>
                <span className="ml-auto text-[11px] text-dim">{ids.length} weapons, {count("good")} good, {count("wrong")} still wrong, {ids.length - count("good") - count("wrong")} not reviewed</span>
            </header>
            {r.body && <p className="border-b border-line px-4 py-2 text-[12px] text-dim">{r.body}</p>}
            <div className="divide-y divide-line">{ids.map((id) => <Weapon key={id} rkey={r.key} id={id} w={r.weapons[id]} />)}</div>
            {ids.length === 0 && <p className="px-4 py-4 text-[12px] text-muted">Nothing filed under this review yet.</p>}
        </section>
    )
}

function Weapon({ rkey, id, w }: { rkey: string; id: string; w: ReviewWeapon }) {
    const router = useRouter()
    const [note, setNote] = useState(w.note)
    const [busy, setBusy] = useState(false)
    const [err, setErr] = useState("")
    const v = VERDICT[w.verdict] ?? VERDICT[""]
    const visual = w.media.filter((m) => m.slot !== "audio")
    const groups = useMemo(() => toGroups(rkey, w, visual), [rkey, w, visual])
    const [modes, setModes] = useState<Record<string, "a" | "b" | "slider" | "side">>({})
    const [open, setOpen] = useState<number | null>(null)
    const audio = w.media.filter((m) => m.slot === "audio")
    async function send(verdict: string) {
        setBusy(true); setErr("")
        try {
            const res = await fetch("/api/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "verdict", key: rkey, weapon: id, verdict, note, by: "christian" }) })
            if (!res.ok) setErr(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `HTTP ${res.status}`)
            else router.refresh()
        } finally { setBusy(false) }
    }
    return (
        <div className="px-4 py-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
                <h3 className="text-[13px] font-medium">{w.title}</h3>
                <code className="font-mono text-[11px] text-muted">{id}</code>
                <span className={`rounded px-1.5 text-[11px] ${v.cls}`}>{v.label}</span>
                {w.at && <span className="text-[11px] text-muted">{w.by} {w.at.slice(0, 16).replace("T", " ")}</span>}
            </div>
            {w.look && <p className="mb-2 text-[13px]"><span className="label mr-1.5">Look for</span>{w.look}</p>}
            {groups.length > 0 && (
                <div className="space-y-5">
                    {groups.map((g, i) => (
                        <div key={g.id}>
                            <div className="mb-1 text-[12px] text-dim">{g.title}{g.a.look && g.a.look !== w.look ? <span className="text-muted"> - look for: {g.a.look}</span> : null}</div>
                            <Stage group={g} mode={modes[g.id] ?? (g.b ? "slider" : "a")} setMode={g.b ? (m) => setModes({ ...modes, [g.id]: m }) : undefined} onOpen={() => setOpen(i)} />
                            <div className="mt-1.5"><Metrics a={g.a.metrics} b={g.b?.metrics} /></div>
                        </div>
                    ))}
                    {w.metrics && Object.keys(w.metrics).length > 0 && <Metrics a={w.metrics} />}
                </div>
            )}
            {open !== null && <Viewer groups={groups} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
            {audio.length > 0 && (
                <div className="mt-3 space-y-2">
                    {audio.map((m) => <Audio key={m.file} m={m} rkey={rkey} />)}
                </div>
            )}
            <div className="mt-3 flex flex-wrap items-start gap-2">
                <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note for the builder (what is still wrong)" className="min-w-0 basis-60 flex-1 rounded-md border border-line bg-transparent px-2 py-1 text-[12px]" />
                <button disabled={busy} onClick={() => send("good")} className="rounded-md bg-emerald-400/15 px-3 py-1 text-[12px] text-emerald-300 hover:bg-emerald-400/25">Good</button>
                <button disabled={busy} onClick={() => send("wrong")} className="rounded-md bg-red-400/15 px-3 py-1 text-[12px] text-red-300 hover:bg-red-400/25">Still wrong</button>
                {(w.verdict || w.note) && <button disabled={busy} onClick={() => send("")} className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-hover">Clear</button>}
                {err && <span className="text-[11px] text-red-300">{err}</span>}
            </div>
        </div>
    )
}

const item = (rkey: string, m: ReviewMedia, w: ReviewWeapon): MediaItem => ({
    src: url(rkey, m.file), kind: /\.(mp4|webm)$/i.test(m.file) ? "video" : "image", label: m.label, variant: m.variant,
    poster: m.poster ? url(rkey, m.poster) : undefined, strip: m.strip ? url(rkey, m.strip) : undefined,
    duration: m.duration, fps: m.fps, width: m.width, height: m.height,
    look: m.look || w.look, metrics: m.metrics ?? undefined,
})

/** Pair before/after of the same slot and label; anything else stands alone. */
function toGroups(rkey: string, w: ReviewWeapon, media: ReviewMedia[]): MediaGroup[] {
    // A screenshot and its clip are one capture: the clip plays, the still is its poster.
    const slotKey = (m: ReviewMedia) => (m.slot === "screenshot" || m.slot === "clip" ? "shot" : m.slot)
    const by = new Map<string, ReviewMedia[]>()
    for (const m of media) by.set(`${slotKey(m)}|${m.label}`, [...(by.get(`${slotKey(m)}|${m.label}`) ?? []), m])
    const pick = (ms: ReviewMedia[], variant?: string): MediaItem | undefined => {
        const v = ms.filter((m) => (m.variant || "") === (variant || ""))
        const clip = v.find((m) => m.slot === "clip"), still = v.find((m) => m.slot === "screenshot")
        const base = clip ?? still ?? v[0]
        if (!base) return undefined
        const it = item(rkey, base, w)
        if (clip && still && !it.poster) it.poster = url(rkey, still.file)
        if (clip && still) it.look = it.look || still.look || w.look, it.metrics = it.metrics ?? still.metrics ?? undefined
        return it
    }
    const out: MediaGroup[] = []
    for (const [k, ms] of by) {
        const title = k.replace("|", ": ")
        const before = pick(ms, "before"), after = pick(ms, "after")
        if (before && after) out.push({ id: k, title, a: before, b: after })
        else for (const variant of [...new Set(ms.map((m) => m.variant || ""))]) {
            const it = pick(ms, variant)
            if (it) out.push({ id: `${k}|${variant}`, title: `${title}${variant ? ` (${variant})` : ""}`, a: it })
        }
    }
    return out
}

function Audio({ m, rkey }: { m: ReviewMedia; rkey: string }) {
    return (
        <div className="rounded border border-line px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-3">
                <span className="text-[12px] font-medium">{m.label}</span>
                {m.variant && <span className="rounded bg-hover px-1.5 text-[11px] text-dim">{m.variant}</span>}
                <audio controls preload="none" src={url(rkey, m.file)} className="h-8" />
            </div>
            {m.waveform && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={url(rkey, m.waveform)} alt={`waveform of ${m.label}`} loading="lazy" className="mt-1 h-16 w-full rounded bg-black object-fill" />
            )}
            <div className="mt-0.5 text-[11px] text-muted">
                Licence: {m.licence || "not recorded"}
                {m.source && <> · {/^https?:\/\//.test(m.source) ? <a href={m.source} className="underline" target="_blank" rel="noreferrer">{m.source}</a> : m.source}</>}
                {m.note ? ` · ${m.note}` : ""}
            </div>
        </div>
    )
}

function Docs() {
    return (
        <section className="mt-8 border-t border-line pt-4 text-[12px] text-dim">
            <span className="label">Filing a review</span>
            <p className="mt-2">One review item per piece of work (a reload pass, a sound pass), one entry per weapon under it. From any machine with curl and python3 (<code className="font-mono">QA_URL</code>, <code className="font-mono">QA_USER</code>, <code className="font-mono">QA_PASSWORD</code> as for <code className="font-mono">qa-post.sh</code>):</p>
            <pre className="mt-2 overflow-x-auto rounded-md bg-hover p-3 font-mono text-[11px] leading-relaxed">{`scripts/review-post.sh new reload-pass "Reload animations"
scripts/review-post.sh media reload-pass smg before.png --slot filmstrip --variant before --title "SMG"
scripts/review-post.sh media reload-pass smg after.png --slot filmstrip --variant after
scripts/review-post.sh media reload-pass smg reload.webm --slot clip --variant after       # mp4, webm or gif, loops
scripts/review-post.sh media reload-pass smg fire.wav --slot audio --licence "CC0" --source https://...   # waveform drawn for you
scripts/review-post.sh open reload-pass                    # builders: weapons not yet good, with the notes`}</pre>
            <p className="mt-2">On dev01 the same thing is <code className="font-mono">nightly review new|media|verdict|show|open|list</code>. Posting a file again with the same slot, variant and label replaces it. Verdicts are kept in <code className="font-mono">review.json</code> with their history.</p>
        </section>
    )
}
