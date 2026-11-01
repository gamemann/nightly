"use client"
import { useCallback, useEffect, useRef, useState } from "react"

/** One image or video the reviewer looks at. `poster`/`strip` exist for videos made by the panel (strip = 8 tiles side by side). */
export type MediaItem = {
    src: string; kind: "image" | "video"; label: string; variant?: string
    poster?: string; strip?: string; duration?: number; fps?: number; width?: number; height?: number
    look?: string; metrics?: Record<string, string | number | boolean>
}
/** A before/after pair (or a single item) shown together at the same size. */
export type MediaGroup = { id: string; title: string; a: MediaItem; b?: MediaItem }
type Mode = "a" | "b" | "slider" | "side"

function useInView<T extends Element>(rootMargin = "400px") {
    const ref = useRef<T | null>(null)
    const [seen, setSeen] = useState(false)
    useEffect(() => {
        const el = ref.current
        if (!el || seen) return
        const io = new IntersectionObserver((e) => { if (e.some((x) => x.isIntersecting)) { setSeen(true); io.disconnect() } }, { rootMargin })
        io.observe(el)
        return () => io.disconnect()
    }, [seen, rootMargin])
    return [ref, seen] as const
}

const fmt = (v: string | number | boolean) => (typeof v === "number" ? String(Math.round(v * 1000) / 1000) : String(v))

/** Measured numbers; with a pair, one row per metric with before, after and the change. */
export function Metrics({ a, b }: { a?: MediaItem["metrics"]; b?: MediaItem["metrics"] }) {
    const names = Array.from(new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]))
    if (names.length === 0) return null
    if (!b || !a) {
        const m = a ?? b ?? {}
        return <div className="flex flex-wrap gap-1.5">{names.map((n) => <span key={n} className="rounded bg-hover px-1.5 py-0.5 font-mono text-[11px]"><span className="text-muted">{n}</span> {fmt(m[n])}</span>)}</div>
    }
    return (
        <table className="w-full max-w-md border-collapse font-mono text-[11px]">
            <thead><tr className="text-left text-muted"><th className="font-normal">metric</th><th className="font-normal">before</th><th className="font-normal">after</th><th className="font-normal">change</th></tr></thead>
            <tbody>{names.map((n) => {
                const x = a[n], y = b[n]
                const d = typeof x === "number" && typeof y === "number" ? y - x : null
                return <tr key={n} className="border-t border-line"><td className="py-0.5 pr-3 text-dim">{n}</td><td className="pr-3">{x === undefined ? "-" : fmt(x)}</td><td className="pr-3">{y === undefined ? "-" : fmt(y)}</td><td>{d === null ? "" : `${d > 0 ? "+" : ""}${Math.round(d * 1000) / 1000}`}</td></tr>
            })}</tbody>
        </table>
    )
}

type Transport = { videos: React.MutableRefObject<(HTMLVideoElement | null)[]>; t: number; dur: number; playing: boolean; rate: number }

/** Shared play / scrub / frame-step state for the videos of one stage; every video follows the first. */
function useTransport(fps: number, dur0: number, active: boolean) {
    const videos = useRef<(HTMLVideoElement | null)[]>([])
    const [s, setS] = useState({ t: 0, dur: dur0, playing: true, rate: 1 })
    useEffect(() => {
        if (!active) return
        let raf = 0
        const tick = () => {
            const v = videos.current[0]
            if (v) {
                setS((p) => (Math.abs(p.t - v.currentTime) > 0.01 || p.dur !== (v.duration || p.dur) || p.playing === v.paused ? { ...p, t: v.currentTime, dur: v.duration || p.dur, playing: !v.paused } : p))
                for (const o of videos.current.slice(1)) if (o && !v.paused && Math.abs(o.currentTime - v.currentTime) > 0.12) o.currentTime = v.currentTime
            }
            raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [active])
    const all = (f: (v: HTMLVideoElement) => void) => videos.current.forEach((v) => v && f(v))
    const api = {
        ...s,
        toggle: () => { const v = videos.current[0]; if (!v) return; if (v.paused) all((x) => void x.play().catch(() => {})); else all((x) => x.pause()) },
        seek: (t: number) => all((v) => { v.pause(); v.currentTime = Math.max(0, Math.min(t, (v.duration || t) - 0.001)) }),
        step: (n: number) => all((v) => { v.pause(); v.currentTime = Math.max(0, Math.min(v.currentTime + n / (fps || 30), (v.duration || 1e9) - 0.001)) }),
        setRate: (r: number) => { all((v) => { v.playbackRate = r }); setS((p) => ({ ...p, rate: r })) },
    }
    return { videos, api }
}

function Bar({ api, fps, strip, dur }: { api: ReturnType<typeof useTransport>["api"]; fps: number; strip?: string; dur: number }) {
    const btn = "rounded border border-line px-2 py-1 text-[12px] hover:bg-hover disabled:opacity-40"
    const frame = Math.round(api.t * (fps || 30))
    return (
        <div className="mt-1.5 space-y-1.5 text-[12px]">
            <div className="flex flex-wrap items-center gap-1.5">
                <button className={btn} onClick={api.toggle} aria-label="play or pause">{api.playing ? "Pause" : "Play"}</button>
                <button className={btn} onClick={() => api.step(-1)} aria-label="previous frame">&lt; frame</button>
                <button className={btn} onClick={() => api.step(1)} aria-label="next frame">frame &gt;</button>
                {[1, 0.5, 0.25].map((r) => <button key={r} className={`${btn} ${api.rate === r ? "bg-hover font-semibold" : ""}`} onClick={() => api.setRate(r)}>{r}x</button>)}
                <span className="ml-auto font-mono tabular-nums text-muted">{api.t.toFixed(2)}s / {(api.dur || dur).toFixed(2)}s · f{frame}</span>
            </div>
            <input type="range" min={0} max={api.dur || dur || 1} step={1 / (fps || 30)} value={api.t} onChange={(e) => api.seek(Number(e.target.value))} className="w-full" aria-label="scrub" />
            {strip && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={strip} alt="frames" loading="lazy" className="w-full cursor-pointer rounded border border-line" onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect()
                    api.seek(((e.clientX - r.left) / r.width) * (api.dur || dur))
                }} />
            )}
        </div>
    )
}

/** The media of one group at the same size: A, B, a slider between them, or side by side. Videos share one transport. */
export function Stage({ group, mode, setMode, zoom, onOpen }: { group: MediaGroup; mode: Mode; setMode?: (m: Mode) => void; zoom?: boolean; onOpen?: () => void }) {
    const { a, b } = group
    const [ref, seen] = useInView<HTMLDivElement>()
    const live = seen || !!zoom
    const isVid = a.kind === "video"
    const fps = a.fps ?? 30
    const { videos, api } = useTransport(fps, a.duration ?? 0, live && isVid)
    const [pos, setPos] = useState(50)
    const view = useRef({ s: 1, x: 0, y: 0 })
    const [, force] = useState(0)
    const box = useRef<HTMLDivElement | null>(null)
    const pts = useRef(new Map<number, { x: number; y: number }>())
    const pinch = useRef(0)
    const moved = useRef(false)
    const set = (s: number, x: number, y: number) => { view.current = { s: Math.max(0.25, Math.min(s, 40)), x, y }; force((n) => n + 1) }
    const reset = useCallback(() => { view.current = { s: 1, x: 0, y: 0 }; force((n) => n + 1) }, [])
    useEffect(reset, [group.id, reset])
    const tf = zoom ? { transform: `translate(${view.current.x}px, ${view.current.y}px) scale(${view.current.s})`, transformOrigin: "center", touchAction: "none" as const } : undefined
    const media = (m: MediaItem, i: number, style?: React.CSSProperties) =>
        m.kind === "video"
            ? <video key={m.src} ref={(el) => { videos.current[i] = el }} src={live ? m.src : undefined} poster={m.poster} loop autoPlay muted playsInline preload={live ? "auto" : "none"} draggable={false} className="block h-auto w-full select-none bg-black" style={style} />
            // eslint-disable-next-line @next/next/no-img-element
            : <img key={m.src} src={live ? m.src : undefined} alt={m.label} draggable={false} loading="lazy" className="block h-auto w-full select-none bg-black" style={style} />
    const nat = (m: MediaItem) => ({ w: m.width ?? 0 })
    void nat
    const down = (e: React.PointerEvent) => { if (!zoom) return; (e.currentTarget as Element).setPointerCapture(e.pointerId); pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY }); moved.current = false }
    const move = (e: React.PointerEvent) => {
        if (!zoom || !pts.current.has(e.pointerId)) return
        const prev = pts.current.get(e.pointerId)!
        pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
        const v = view.current
        if (pts.current.size === 2) {
            const [p, q] = [...pts.current.values()]
            const d = Math.hypot(p.x - q.x, p.y - q.y)
            if (pinch.current) set(v.s * (d / pinch.current), v.x, v.y)
            pinch.current = d
        } else {
            moved.current = true
            set(v.s, v.x + e.clientX - prev.x, v.y + e.clientY - prev.y)
        }
    }
    const up = (e: React.PointerEvent) => { pts.current.delete(e.pointerId); pinch.current = 0 }
    const wheel = (e: React.WheelEvent) => {
        if (!zoom || !box.current) return
        const r = box.current.getBoundingClientRect()
        const cx = e.clientX - r.left - r.width / 2, cy = e.clientY - r.top - r.height / 2
        const v = view.current
        const s2 = Math.max(0.25, Math.min(v.s * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 40))
        set(s2, cx - (cx - v.x) * (s2 / v.s), cy - (cy - v.y) * (s2 / v.s))
    }
    const native = () => {
        const el = box.current?.querySelector("img,video") as (HTMLImageElement | HTMLVideoElement) | null
        if (!el) return
        const nw = el instanceof HTMLImageElement ? el.naturalWidth : el.videoWidth
        if (nw && el.offsetWidth) set(nw / el.offsetWidth, 0, 0)
    }
    useEffect(() => {
        if (!zoom) return
        const key = (e: KeyboardEvent) => {
            if (e.key === "+" || e.key === "=") set(view.current.s * 1.25, view.current.x, view.current.y)
            else if (e.key === "-") set(view.current.s / 1.25, view.current.x, view.current.y)
            else if (e.key === "0") reset()
            else if (e.key === "1") native()
            else if (e.key === " " && isVid) { e.preventDefault(); api.toggle() }
            else if (e.key === "," && isVid) api.step(-1)
            else if (e.key === "." && isVid) api.step(1)
            else if ((e.key === "b" || e.key === "Tab") && b) { e.preventDefault(); setMode?.(mode === "a" ? "b" : "a") }
        }
        window.addEventListener("keydown", key)
        return () => window.removeEventListener("keydown", key)
    })
    const modes: [Mode, string][] = b ? [["slider", "Slider"], ["a", "Before"], ["b", "After"], ["side", "Side by side"]] : []
    return (
        <div ref={ref}>
            {b && setMode && (
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
                    {modes.map(([m, l]) => <button key={m} onClick={() => setMode(m)} className={`rounded border border-line px-2 py-1 hover:bg-hover ${mode === m ? "bg-hover font-semibold" : ""}`}>{l}</button>)}
                    {zoom && <span className="text-muted">B or Tab toggles before/after</span>}
                </div>
            )}
            <div ref={box} className={`relative overflow-hidden rounded border border-line bg-black ${zoom ? "flex h-[70vh] items-center justify-center max-md:h-[55vh]" : ""} ${zoom ? "cursor-grab" : onOpen ? "cursor-zoom-in" : ""}`}
                onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onWheel={wheel} onDoubleClick={() => (zoom ? (view.current.s === 1 ? native() : reset()) : undefined)}
                onClick={() => { if (!zoom && onOpen) onOpen() }}>
                {mode === "side" && b ? (
                    <div className="grid w-full grid-cols-2 gap-px max-md:grid-cols-1"><div className="relative">{media(a, 0)}<Tag t={a.variant || "A"} /></div><div className="relative">{media(b, 1)}<Tag t={b.variant || "B"} /></div></div>
                ) : mode === "slider" && b ? (
                    <div className="relative w-full" style={tf}>
                        {media(a, 0)}
                        <div className="absolute inset-0" style={{ clipPath: `inset(0 0 0 ${pos}%)` }}>{media(b, 1)}</div>
                        <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white/80" style={{ left: `${pos}%` }} />
                        <Tag t={a.variant || "before"} /><Tag t={b.variant || "after"} right />
                    </div>
                ) : (
                    <div className="relative w-full" style={tf}>{media(mode === "b" && b ? b : a, 0)}{b && <Tag t={(mode === "b" ? b : a).variant || mode} />}</div>
                )}
            </div>
            {mode === "slider" && b && <input type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} className="mt-1 w-full" aria-label="before / after slider" onPointerDown={(e) => e.stopPropagation()} />}
            {zoom && <div className="mt-1 flex flex-wrap gap-1.5 text-[12px]"><button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={reset}>Fit</button><button className="rounded border border-line px-2 py-1 hover:bg-hover" onClick={native}>Native (1:1)</button><span className="text-muted">{(view.current.s * 100).toFixed(0)}% of fit · wheel or pinch zoom, drag pans, double-click toggles 1:1</span></div>}
            {isVid && <Bar api={api} fps={fps} strip={a.strip} dur={a.duration ?? 0} />}
        </div>
    )
}

function Tag({ t, right }: { t: string; right?: boolean }) {
    return <span className={`pointer-events-none absolute top-1.5 rounded bg-black/70 px-1.5 py-0.5 text-[11px] text-white ${right ? "right-1.5" : "left-1.5"}`}>{t}</span>
}

/** Full-screen viewer over a list of groups: arrow keys next/prev, Esc closes. */
export function Viewer({ groups, index, onIndex, onClose }: { groups: MediaGroup[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
    const g = groups[index]
    const [mode, setMode] = useState<Mode>(g.b ? "slider" : "a")
    useEffect(() => setMode(g.b ? "slider" : "a"), [g.id, g.b])
    useEffect(() => {
        const key = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose()
            else if (e.key === "ArrowRight") onIndex((index + 1) % groups.length)
            else if (e.key === "ArrowLeft") onIndex((index - 1 + groups.length) % groups.length)
        }
        window.addEventListener("keydown", key)
        const prev = document.body.style.overflow
        document.body.style.overflow = "hidden"
        return () => { window.removeEventListener("keydown", key); document.body.style.overflow = prev }
    }, [index, groups.length, onIndex, onClose])
    return (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/90 p-3 text-white max-md:p-2" role="dialog" aria-label="media viewer">
            <div className="mx-auto max-w-[1600px] rounded-lg bg-[var(--bg,#111)] p-3 [&_*]:border-white/20" style={{ background: "#111" }}>
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[13px]">
                    <button onClick={() => onIndex((index - 1 + groups.length) % groups.length)} className="rounded border px-3 py-1.5" aria-label="previous">&larr;</button>
                    <button onClick={() => onIndex((index + 1) % groups.length)} className="rounded border px-3 py-1.5" aria-label="next">&rarr;</button>
                    <span className="min-w-0 flex-1 truncate font-medium">{g.title}</span>
                    <span className="text-white/60">{index + 1} / {groups.length}</span>
                    <button onClick={onClose} className="rounded border px-3 py-1.5" aria-label="close">Close (Esc)</button>
                </div>
                {g.a.look && <p className="mb-2 text-[13px] text-white/80">Look for: {g.a.look}</p>}
                <Stage group={g} mode={mode} setMode={setMode} zoom />
                <div className="mt-2"><Metrics a={g.a.metrics} b={g.b?.metrics} /></div>
            </div>
        </div>
    )
}
