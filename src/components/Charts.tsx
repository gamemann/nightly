"use client"
// Chart pieces shared by every tab except Performance (which has its own in PerfChart.tsx). Same rules: no chart library,
// text in text tokens, colour from lib/charts.mjs (colour-blind-safe, validated on the dark surface) and never the only
// carrier of state: each mark has a tooltip, an aria-label, and where it is a state, its word in a legend.
import { useState, type KeyboardEvent, type ReactNode } from "react"
import { COLOR } from "../../lib/charts.mjs"

/** Card with a title, a one-line subtitle saying what and over what, optional legend, and an empty state. */
export function Panel({ title, subtitle, legend, empty, children, right }: { title: string; subtitle?: string; legend?: ReactNode; empty?: string | false; children?: ReactNode; right?: ReactNode }) {
    return (
        <figure className="rounded-lg border border-line bg-panel/40 p-3">
            <figcaption className="mb-2 flex items-start justify-between gap-3">
                <span>
                    <span className="block text-[13px] text-fg">{title}</span>
                    {subtitle && <span className="block text-[11px] text-muted">{subtitle}</span>}
                </span>
                {right}
            </figcaption>
            {empty ? <div className="py-6 text-center text-[12px] text-muted">{empty}</div> : children}
            {legend && !empty && <div className="mt-2">{legend}</div>}
        </figure>
    )
}

/** Colour swatch + word per state; the word is what carries identity for readers who cannot tell the swatches apart. */
export function Legend({ items }: { items: { label: string; color: string; count?: number }[] }) {
    return (
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dim">
            {items.map((i) => (
                <li key={i.label} className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: i.color }} aria-hidden />
                    {i.label}{i.count != null && <span className="tabular-nums text-muted">{i.count}</span>}
                </li>
            ))}
        </ul>
    )
}

/** Headline number with a label and optional small note; the one form that needs no plot. */
export function StatTile({ label, value, note, href }: { label: string; value: ReactNode; note?: string; href?: string }) {
    const body = (
        <>
            <span className="block text-[11px] text-muted">{label}</span>
            <span className="block text-[20px] font-semibold tabular-nums leading-tight">{value}</span>
            {note && <span className="block text-[11px] text-muted">{note}</span>}
        </>
    )
    const cls = "rounded-lg border border-line bg-panel/40 px-3 py-2"
    return href ? <a href={href} className={`${cls} hover:bg-hover/50`}>{body}</a> : <div className={cls}>{body}</div>
}

export type StackBar = { key: string; label: string; segments: { key: string; label: string; value: number; color: string }[]; id?: number | string }

/** Vertical stacked bars (one per bucket) with 2px gaps between segments, a shared tooltip on hover or focus, arrow-key
 *  navigation and click-through. Segment order is bottom first. */
export function StackedBars({ bars, unit = "runs", height = 120, onBar, ariaLabel }: { bars: StackBar[]; unit?: string; height?: number; onBar?: (bar: StackBar) => void; ariaLabel: string }) {
    const [at, setAt] = useState<number | null>(null)
    const sum = (b: StackBar) => b.segments.reduce((n, s) => n + s.value, 0)
    const text = (b: StackBar) => `${b.label}: ${b.segments.filter((s) => s.value).map((s) => `${s.value} ${s.label}`).join(", ") || `no ${unit}`}`
    const max = Math.max(1, ...bars.map(sum))
    const tip = at != null && bars[at] ? text(bars[at]) : ""
    const move = (e: KeyboardEvent, i: number) => {
        const d = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0
        if (!d) return
        e.preventDefault()
        const n = Math.max(0, Math.min(bars.length - 1, i + d))
        setAt(n)
        ;(e.currentTarget.parentElement?.children[n] as HTMLElement | undefined)?.focus()
    }
    return (
        <div>
            <div className="flex items-end border-b border-line" style={{ height }} role="group" aria-label={ariaLabel} onMouseLeave={() => setAt(null)}>
                {bars.map((b, i) => (
                    <button key={b.key} type="button" aria-label={text(b)} onMouseEnter={() => setAt(i)} onFocus={() => setAt(i)} onBlur={() => setAt(null)} onKeyDown={(e) => move(e, i)} onClick={() => sum(b) && onBar?.(b)}
                        className="flex h-full min-w-0 flex-1 flex-col justify-end px-px outline-offset-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent" style={{ cursor: onBar && sum(b) ? "pointer" : "default" }}>
                        <span className="flex flex-col-reverse gap-[2px]" style={{ height: `${(sum(b) / max) * 100}%`, opacity: at != null && at !== i ? 0.55 : 1 }}>
                            {b.segments.filter((s) => s.value > 0).map((s, k, a) => (
                                <span key={s.key} style={{ flex: s.value, background: s.color, borderRadius: k === a.length - 1 ? "3px 3px 0 0" : 0, minHeight: 2 }} />
                            ))}
                        </span>
                    </button>
                ))}
            </div>
            <div className="mt-1 flex justify-between gap-2 text-[10px] tabular-nums text-muted"><span>{bars[0]?.label}</span><span role="status" className="min-h-3 text-dim">{tip}</span><span>{bars[bars.length - 1]?.label}</span></div>
        </div>
    )
}

export type HeatRow = { key: string; label: string; cells: { key: string; value: number | null; tip: string; id?: number | string }[] }

/** Heatmap in one hue by value/max (sequential), or good/warn/bad by ratio 0..1 when `ratio`. Empty cells (null) are an
 *  outline, so "nothing ran" differs from zero. */
export function HeatGrid({ rows, cols, max, ratio, onCell, ariaLabel, labelWidth = 128 }: { rows: HeatRow[]; cols: string[]; max?: number; ratio?: boolean; onCell?: (row: string, id: number | string | undefined) => void; ariaLabel: string; labelWidth?: number }) {
    const [tip, setTip] = useState("")
    const m = max ?? Math.max(1, ...rows.flatMap((r) => r.cells.map((c) => c.value ?? 0)))
    const fill = (v: number | null) => {
        if (v === null) return "transparent"
        if (ratio) return v >= 0.999 ? COLOR.good : v >= 0.5 ? COLOR.warn : COLOR.bad
        return v === 0 ? "var(--color-line)" : `color-mix(in srgb, ${COLOR.seq} ${Math.round(20 + (v / m) * 80)}%, transparent)`
    }
    return (
        <div>
            <div className="overflow-x-auto" role="table" aria-label={ariaLabel}>
                {rows.map((r) => (
                    <div role="row" key={r.key} className="flex items-center gap-2 py-px">
                        <span className="shrink-0 truncate text-[11px] text-dim" style={{ width: labelWidth }} title={r.label}>{r.label}</span>
                        <span className="flex min-w-0 flex-1 gap-[2px]">
                            {r.cells.map((c) => (
                                <button role="cell" type="button" key={c.key} aria-label={c.tip} disabled={!onCell || c.id == null} onMouseEnter={() => setTip(c.tip)} onFocus={() => setTip(c.tip)} onMouseLeave={() => setTip("")} onClick={() => onCell?.(r.key, c.id)}
                                    className="h-4 min-w-[6px] flex-1 rounded-[2px] outline-offset-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent enabled:cursor-pointer enabled:hover:brightness-125" style={{ background: fill(c.value), boxShadow: c.value === null ? "inset 0 0 0 1px var(--color-line)" : undefined }} />
                            ))}
                        </span>
                    </div>
                ))}
            </div>
            <div className="mt-1 flex justify-between gap-2 text-[10px] tabular-nums text-muted" style={{ paddingLeft: labelWidth + 8 }}><span>{cols[0]}</span><span role="status" className="min-h-3 text-dim">{tip}</span><span>{cols[cols.length - 1]}</span></div>
        </div>
    )
}

/** Horizontal timeline of upcoming events (hours from now), one lane per schedule so labels never overlap. Each event is a
 *  focusable marker with a tooltip. */
export function Timeline({ events, hours = 48, onEvent, ariaLabel }: { events: { key: string; lane: string; label: string; inHours: number; id?: number | string }[]; hours?: number; onEvent?: (id: number | string | undefined) => void; ariaLabel: string }) {
    const [tip, setTip] = useState("")
    const lanes = [...new Set(events.map((e) => e.lane))]
    const ticks = Array.from({ length: Math.floor(hours / 12) + 1 }, (_, i) => i * 12)
    return (
        <div>
            <div className="relative" role="group" aria-label={ariaLabel} style={{ height: lanes.length * 18 + 18 }} onMouseLeave={() => setTip("")}>
                {ticks.map((h) => <span key={h} className="absolute top-0 bottom-4 border-l border-line/70" style={{ left: `${(h / hours) * 100}%` }} aria-hidden />)}
                {lanes.map((l, li) => (
                    <div key={l} className="absolute inset-x-0 h-[18px]" style={{ top: li * 18 }}>
                        <span className="absolute inset-x-0 top-1/2 h-px bg-line" aria-hidden />
                        {events.filter((e) => e.lane === l).map((e) => (
                            <button key={e.key} type="button" aria-label={e.label} onMouseEnter={() => setTip(e.label)} onFocus={() => setTip(e.label)} onClick={() => onEvent?.(e.id)}
                                className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full outline-offset-2 hover:scale-125 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent" style={{ left: `${(e.inHours / hours) * 100}%`, background: COLOR.info, boxShadow: "0 0 0 2px var(--color-panel)" }} />
                        ))}
                    </div>
                ))}
                {ticks.map((h) => <span key={h} className="absolute bottom-0 -translate-x-1/2 text-[10px] tabular-nums text-muted" style={{ left: `${(h / hours) * 100}%` }}>{h === 0 ? "now" : `+${h}h`}</span>)}
            </div>
            <div role="status" className="mt-1 min-h-4 text-[11px] text-dim">{tip}</div>
        </div>
    )
}
