"use client"
// Reusable SVG chart primitives (no chart library). Used by the Performance dashboard and any view that shows numbers
// over time or by category: LineChart (hover crosshair + tooltip, synced hover, brush zoom, legend toggles, log scale,
// smoothing, bands, budget lines, regression markers, click-through), Sparkline, BarList, Heatmap, Donut.
// Colour follows the entity (fixed palette in lib/perf-chart.mjs), text uses text tokens, status is icon + label.
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { PALETTE, dateFull, dateLabel, fmt, logTicks, movingAverage, nearest, niceTicks, timeTicks, yDomain } from "../../lib/perf-chart.mjs"

export type ChartPoint = { t: number; v: number; id?: number | string; meta?: Record<string, string | number | null | undefined> }
export type ChartSeries = { key: string; label: string; color: string; points: ChartPoint[]; dashed?: boolean }
export type ChartBand = { from: string; to: string; color: string }
export type ChartLine = { value: number; label: string; kind?: "max" | "min" }
export type ChartMarker = { t: number; v: number; id?: number | string; reason: string }
/** Shared across charts: the hovered time and the zoomed range. Hold this state in the parent and pass it to every chart. */
export type ChartSync = { hover: number | null; setHover: (t: number | null) => void; range: [number, number] | null; setRange: (r: [number, number] | null) => void }

export function useChartSync(): ChartSync {
    const [hover, setHover] = useState<number | null>(null)
    const [range, setRange] = useState<[number, number] | null>(null)
    return { hover, setHover, range, setRange }
}

const W = 640, L = 52, R = 56, T = 10, B = 24
const AXIS = "var(--color-muted)", GRID = "var(--color-line)"

export function LineChart({ title, unit = "", series, bands = [], lines = [], markers = [], height = 220, sync, log = false, smooth = 1, toggles = true, onPointClick, tooltipExtra, empty }: {
    title: string; unit?: string; series: ChartSeries[]; bands?: ChartBand[]; lines?: ChartLine[]; markers?: ChartMarker[]; height?: number
    sync?: ChartSync; log?: boolean; smooth?: number; toggles?: boolean
    onPointClick?: (p: ChartPoint, s: ChartSeries) => void
    tooltipExtra?: (p: ChartPoint, s: ChartSeries) => ReactNode
    empty?: ReactNode
}) {
    const own = useChartSync()
    const S = sync ?? own
    const [off, setOff] = useState<Set<string>>(new Set())
    const [logOn, setLogOn] = useState(log)
    const [sm, setSm] = useState(smooth)
    const [drag, setDrag] = useState<[number, number] | null>(null)
    const ref = useRef<SVGSVGElement>(null)
    const uid = useId()
    const H = height

    const shown = useMemo(() => series.filter((s) => !off.has(s.key)).map((s) => sm > 1 ? { ...s, points: (() => { const m = movingAverage(s.points.map((p) => p.v), sm); return s.points.map((p, i) => ({ ...p, v: m[i] })) })() } : s), [series, off, sm])
    const all = shown.flatMap((s) => s.points)
    const t0All = all.length ? Math.min(...all.map((p) => p.t)) : 0
    const t1All = all.length ? Math.max(...all.map((p) => p.t)) : 1
    const [t0, t1] = S.range ?? [t0All, t1All === t0All ? t0All + 1 : t1All]
    const inView = (p: ChartPoint) => p.t >= t0 && p.t <= t1
    const vis = shown.map((s) => ({ ...s, pts: s.points.filter(inView) }))
    const vals = [...vis.flatMap((s) => s.pts.map((p) => p.v)), ...lines.map((l) => l.value)]
    const dom = yDomain(vals, { log: logOn })
    const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R)
    const y = (v: number) => dom.log ? T + (1 - (Math.log(v) - Math.log(dom.lo)) / (Math.log(dom.hi) - Math.log(dom.lo))) * (H - T - B) : T + (1 - (v - dom.lo) / (dom.hi - dom.lo)) * (H - T - B)
    const yt = dom.log ? logTicks(dom.lo, dom.hi) : niceTicks(dom.lo, dom.hi, 4)
    const xt = timeTicks(t0, t1, 6)
    const tAt = (clientX: number) => { const r = ref.current!.getBoundingClientRect(); const px = ((clientX - r.left) / r.width) * W; return t0 + ((px - L) / (W - L - R)) * (t1 - t0) }

    const hov = S.hover
    const hoverRows = hov === null ? [] : vis.map((s) => { const i = nearest(s.pts, hov); return i < 0 ? null : { s, p: s.pts[i], i } }).filter((r): r is NonNullable<typeof r> => !!r)
    const anchor = hoverRows[0]?.p.t ?? null
    const onMove = useCallback((e: React.PointerEvent) => { const t = tAt(e.clientX); S.setHover(t); if (drag) setDrag([drag[0], t]) }, [drag, S, t0, t1]) // eslint-disable-line react-hooks/exhaustive-deps
    const finish = () => {
        if (drag && Math.abs(x(drag[1]) - x(drag[0])) > 8) S.setRange([Math.min(...drag), Math.max(...drag)])
        setDrag(null)
    }
    const step = (dir: number) => { if (!all.length) return; const base = hoverRows[0]; const pts = base ? base.s.pts : vis[0]?.pts ?? []; if (!pts.length) return; const i = base ? Math.min(pts.length - 1, Math.max(0, base.i + dir)) : dir > 0 ? 0 : pts.length - 1; S.setHover(pts[i].t) }
    const toggle = (k: string) => setOff((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n })
    const firstHit = hoverRows[0]
    const tipLeft = anchor !== null ? (x(anchor) / W) * 100 : 0

    if (!all.length) return <figure className="rounded-lg border border-line bg-panel/40 p-3"><figcaption className="text-[13px]">{title}</figcaption><div className="p-6 text-center text-[12px] text-muted">{empty ?? "No data in this scope."}</div></figure>

    return (
        <figure className="relative rounded-lg border border-line bg-panel/40 p-3 transition-colors hover:border-line-strong">
            <figcaption className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
                <span className="text-[13px] text-fg">{title}</span>{unit && <span className="text-muted">{unit}</span>}
                <span className="ml-auto flex items-center gap-1">
                    {toggles && <button type="button" aria-pressed={logOn} onClick={() => setLogOn(!logOn)} className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${logOn ? "border-accent text-fg" : "border-line text-dim hover:text-fg"}`}>log</button>}
                    {toggles && <button type="button" aria-pressed={sm > 1} onClick={() => setSm(sm > 1 ? 1 : 5)} className={`rounded border px-1.5 py-0.5 text-[11px] transition-colors ${sm > 1 ? "border-accent text-fg" : "border-line text-dim hover:text-fg"}`}>avg 5</button>}
                    {S.range && <button type="button" onClick={() => S.setRange(null)} className="rounded border border-line px-1.5 py-0.5 text-[11px] text-dim hover:text-fg">reset zoom</button>}
                </span>
            </figcaption>
            {series.length > 1 && (
                <div role="group" aria-label="Series" className="mt-1 flex flex-wrap gap-2 text-[11px]">
                    {series.map((s) => <button type="button" key={s.key} aria-pressed={!off.has(s.key)} onClick={() => toggle(s.key)} className={`flex items-center gap-1 rounded px-1 py-0.5 transition-opacity hover:bg-hover ${off.has(s.key) ? "opacity-40" : ""}`}><span className="inline-block h-0.5 w-3" style={{ background: s.color }} /><span className="text-dim">{s.label}</span></button>)}
                </div>
            )}
            <div className="relative">
                <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${title}, ${series.map((s) => s.label).join(", ")}`} tabIndex={0} className="mt-1 w-full touch-none select-none outline-none focus-visible:ring-1 focus-visible:ring-accent"
                    onPointerMove={onMove} onPointerLeave={() => { S.setHover(null); setDrag(null) }} onPointerDown={(e) => setDrag([tAt(e.clientX), tAt(e.clientX)])} onPointerUp={finish}
                    onKeyDown={(e) => { if (e.key === "ArrowRight") { e.preventDefault(); step(1) } else if (e.key === "ArrowLeft") { e.preventDefault(); step(-1) } else if (e.key === "Escape") { S.setHover(null); S.setRange(null) } else if (e.key === "Enter" && firstHit && onPointClick) onPointClick(firstHit.p, firstHit.s) }}>
                    <defs><clipPath id={uid}><rect x={L} y={T} width={W - L - R} height={H - T - B} /></clipPath></defs>
                    {yt.map((v) => <g key={v}><line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={GRID} /><text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize={10} fill={AXIS}>{fmt(v)}</text></g>)}
                    {xt.map((k) => <g key={k.t}><line x1={x(k.t)} x2={x(k.t)} y1={H - B} y2={H - B + 4} stroke={GRID} /><text x={x(k.t)} y={H - 8} textAnchor="middle" fontSize={10} fill={AXIS}>{k.label}</text></g>)}
                    <g clipPath={`url(#${uid})`}>
                        {bands.map((b) => { const a = vis.find((s) => s.key === b.from)?.pts, c = vis.find((s) => s.key === b.to)?.pts; if (!a || !c || a.length < 2) return null; const d = `M${a.map((p) => `${x(p.t)},${y(p.v)}`).join("L")}L${[...c].reverse().map((p) => `${x(p.t)},${y(p.v)}`).join("L")}Z`; return <path key={b.from + b.to} d={d} fill={b.color} opacity={0.14} /> })}
                        {vis.map((s) => s.pts.length > 1 && <polyline key={s.key} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeDasharray={s.dashed ? "5 3" : undefined} points={s.pts.map((p) => `${x(p.t)},${y(p.v)}`).join(" ")} />)}
                        {vis.map((s) => (s.pts.length <= 40 || s.pts.length === 1) && s.pts.map((p) => <circle key={`${s.key}${p.t}`} cx={x(p.t)} cy={y(p.v)} r={s.pts.length === 1 ? 4 : 2.5} fill={s.color} stroke="var(--color-panel)" strokeWidth={1.5} />))}
                        {drag && <rect x={Math.min(x(drag[0]), x(drag[1]))} width={Math.abs(x(drag[1]) - x(drag[0]))} y={T} height={H - T - B} fill="var(--color-accent)" opacity={0.12} />}
                    </g>
                    {lines.map((l) => (l.value >= dom.lo && l.value <= dom.hi) && <g key={l.label}><line x1={L} x2={W - R} y1={y(l.value)} y2={y(l.value)} stroke="#f87171" strokeDasharray="5 3" opacity={0.85} /><text x={W - R - 4} y={y(l.value) - 4} textAnchor="end" fontSize={10} fill="var(--color-dim)">{l.label}</text></g>)}
                    {markers.filter((m) => m.t >= t0 && m.t <= t1).map((m) => <g key={`${m.id}${m.t}`}><title>{m.reason}</title><path d={`M${x(m.t)},${y(m.v) - 11}l6,10h-12z`} fill="#f59e0b" stroke="var(--color-panel)" strokeWidth={1.5} /><text x={x(m.t)} y={y(m.v) - 3.5} textAnchor="middle" fontSize={8} fontWeight={700} fill="#1a1205">!</text></g>)}
                    {anchor !== null && <g pointerEvents="none"><line x1={x(anchor)} x2={x(anchor)} y1={T} y2={H - B} stroke="var(--color-dim)" strokeDasharray="2 3" />{hoverRows.map((r) => <circle key={r.s.key} cx={x(r.p.t)} cy={y(r.p.v)} r={5} fill={r.s.color} stroke="var(--color-fg)" strokeWidth={1.5} />)}</g>}
                    {onPointClick && vis.map((s) => s.pts.map((p) => <circle key={`h${s.key}${p.t}`} cx={x(p.t)} cy={y(p.v)} r={9} fill="transparent" className="cursor-pointer" onClick={() => onPointClick(p, s)} />))}
                </svg>
                {firstHit && anchor !== null && (
                    <div role="status" className="pointer-events-none absolute top-2 z-10 min-w-40 max-w-64 rounded-md border border-line-strong bg-panel-2 p-2 text-[11px] shadow-lg" style={{ left: `${Math.min(Math.max(tipLeft, 15), 85)}%`, transform: "translateX(-50%)" }}>
                        <div className="text-fg">{dateFull(anchor)}</div>
                        {hoverRows.map((r) => <div key={r.s.key} className="mt-0.5 flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: r.s.color }} /><span className="text-dim">{r.s.label}</span><span className="ml-auto tabular-nums text-fg">{fmt(r.p.v, unit)}</span></div>)}
                        {firstHit.p.id !== undefined && <div className="mt-1 border-t border-line pt-1 text-muted">run #{firstHit.p.id}{Object.entries(firstHit.p.meta ?? {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([k, v]) => <span key={k}> · {k} <span className="text-dim">{String(v)}</span></span>)}</div>}
                        {tooltipExtra?.(firstHit.p, firstHit.s)}
                        {markers.filter((m) => m.id === firstHit.p.id).map((m) => <div key={m.reason} className="mt-1 text-amber-300">! {m.reason}</div>)}
                        {onPointClick && <div className="mt-1 text-muted">click or Enter to open</div>}
                    </div>
                )}
            </div>
            <p className="mt-0.5 text-[10px] text-muted">drag to zoom · arrows step · Esc resets{dom.log ? " · log scale" : ""}{sm > 1 ? " · 5-run average" : ""}</p>
        </figure>
    )
}

/** Tiny trend line for cards and table rows. Decorative: pair it with the number. */
export function Sparkline({ values, color = PALETTE.single, w = 96, h = 26, label = "trend" }: { values: number[]; color?: string; w?: number; h?: number; label?: string }) {
    if (values.length < 2) return <span className="text-[10px] text-muted">{values.length ? "1 run" : "-"}</span>
    const lo = Math.min(...values), hi = Math.max(...values), span = hi - lo || 1
    const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 4) + 2},${h - 3 - ((v - lo) / span) * (h - 6)}`)
    const last = pts[pts.length - 1].split(",")
    return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} className="shrink-0"><polyline fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" points={pts.join(" ")} /><circle cx={last[0]} cy={last[1]} r={2.5} fill={color} /></svg>
}

/** Horizontal bars with hover title and optional click-through. Rows: label, value, optional href/colour/note. */
export function BarList({ rows, unit = "", max, onClick }: { rows: { label: string; value: number; color?: string; note?: string; key?: string }[]; unit?: string; max?: number; onClick?: (key: string) => void }) {
    const m = max ?? Math.max(1, ...rows.map((r) => r.value))
    return (
        <ul className="space-y-1">
            {rows.map((r) => (
                <li key={r.key ?? r.label}>
                    <button type="button" disabled={!onClick} onClick={() => onClick?.(r.key ?? r.label)} title={`${r.label}: ${fmt(r.value, unit)}${r.note ? ` (${r.note})` : ""}`} className="group flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-[12px] transition-colors enabled:hover:bg-hover">
                        <span className="w-28 shrink-0 truncate text-dim group-hover:text-fg">{r.label}</span>
                        <span className="h-2 flex-1 overflow-hidden rounded-full bg-line"><span className="block h-full rounded-full transition-all" style={{ width: `${Math.max(2, (r.value / m) * 100)}%`, background: r.color ?? PALETTE.single }} /></span>
                        <span className="w-16 shrink-0 text-right tabular-nums">{fmt(r.value, unit)}</span>
                    </button>
                </li>
            ))}
        </ul>
    )
}

/** Diverging heatmap (rows x columns). z: percent worse (positive, warm) or better (negative, cool); null = no baseline. */
export function Heatmap({ rows, cols, onCell, cap = 30, title }: { rows: { key: string; label: string; cells: { z: number | null; flag?: boolean; tip: string; id?: number | string }[] }[]; cols: string[]; onCell?: (rowKey: string, id: number | string | undefined) => void; cap?: number; title?: string }) {
    const [tip, setTip] = useState<string | null>(null)
    const fill = (z: number | null) => z === null ? "var(--color-line)" : z > 0 ? `rgba(213,94,0,${Math.min(1, 0.12 + (z / cap) * 0.88).toFixed(2)})` : `rgba(86,180,233,${Math.min(0.7, 0.1 + (-z / cap) * 0.6).toFixed(2)})`
    const cw = Math.max(8, Math.min(18, Math.floor(520 / Math.max(1, cols.length))))
    return (
        <div className="rounded-lg border border-line bg-panel/40 p-3">
            {title && <div className="text-[13px]">{title}</div>}
            <div className="mt-2 overflow-x-auto" role="table" aria-label={title ?? "heatmap"}>
                {rows.map((r) => (
                    <div role="row" key={r.key} className="flex items-center gap-2 py-px">
                        <span className="w-32 shrink-0 truncate text-[11px] text-dim" title={r.label}>{r.label}</span>
                        <span className="flex gap-px">{r.cells.map((c, i) => <button role="cell" type="button" key={i} aria-label={c.tip} onMouseEnter={() => setTip(c.tip)} onFocus={() => setTip(c.tip)} onMouseLeave={() => setTip(null)} onClick={() => onCell?.(r.key, c.id)} className="h-4 rounded-[2px] outline-offset-1 transition-transform hover:scale-125 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent" style={{ width: cw, background: fill(c.z), boxShadow: c.flag ? "inset 0 0 0 1px #f59e0b" : undefined }} />)}</span>
                    </div>
                ))}
            </div>
            <div className="mt-2 flex items-center gap-2 text-[10px] text-muted"><span className="inline-block h-2 w-6 rounded-sm" style={{ background: "linear-gradient(90deg, rgba(86,180,233,.6), var(--color-line), rgba(213,94,0,.95))" }} />better · same · worse than the previous 5 runs; outlined = regression ({cols.length} runs)</div>
            <div className="mt-1 h-4 text-[11px] text-dim" aria-live="polite">{tip}</div>
        </div>
    )
}

/** Donut with a centre label and a legend that carries the numbers (so colour is never the only channel). */
export function Donut({ parts, centre, size = 120 }: { parts: { key: string; label: string; value: number; color: string }[]; centre?: ReactNode; size?: number }) {
    const total = parts.reduce((a, p) => a + p.value, 0)
    const r = size / 2 - 8, c = 2 * Math.PI * r
    let off = 0
    const [hot, setHot] = useState<string | null>(null)
    return (
        <div className="flex items-center gap-4">
            <div className="relative shrink-0" style={{ width: size, height: size }}>
                <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={parts.map((p) => `${p.label} ${p.value}`).join(", ")}>
                    <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth={12} />
                    {total > 0 && parts.filter((p) => p.value > 0).map((p) => { const len = (p.value / total) * c; const o = off; off += len; return <circle key={p.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={p.color} strokeWidth={hot === p.key ? 15 : 12} strokeDasharray={`${Math.max(0, len - 2)} ${c}`} strokeDashoffset={-o} transform={`rotate(-90 ${size / 2} ${size / 2})`} className="transition-all" onMouseEnter={() => setHot(p.key)} onMouseLeave={() => setHot(null)}><title>{`${p.label}: ${p.value} (${Math.round((p.value / total) * 100)}%)`}</title></circle> })}
                </svg>
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-center text-[12px]">{centre ?? <span className="tabular-nums">{total}</span>}</div>
            </div>
            <ul className="space-y-0.5 text-[12px]">{parts.map((p) => <li key={p.key} onMouseEnter={() => setHot(p.key)} onMouseLeave={() => setHot(null)} className="flex items-center gap-2"><span className="inline-block h-2 w-2 rounded-sm" style={{ background: p.color }} /><span className="text-dim">{p.label}</span><span className="ml-auto pl-3 tabular-nums">{p.value}{total ? <span className="text-muted"> {Math.round((p.value / total) * 100)}%</span> : null}</span></li>)}</ul>
        </div>
    )
}

export { dateLabel }
