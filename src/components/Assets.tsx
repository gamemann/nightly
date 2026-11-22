"use client"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useMemo } from "react"
import { BarList, Sparkline } from "./PerfChart"
import { Legend, Panel, StackedBars } from "./Charts"
import { COLOR, flagCounts, passByGroup, scoreBins, worstOffenders } from "../../lib/charts.mjs"

export type Tab = "models" | "textures" | "animations" | "sounds"
export type AssetRow = {
    id: number; pack: string; game: string; weaponId: string; kind: string; source: string; score: number; pass: boolean; auditedAt: string
    hasModel: boolean; tris: number; verts: number; materials: number
    texCount: number; texMax: number; texBytes: number; texMaps: string[]
    animCount: number; animLen: number; soundCount: number; soundLen: number; soundBytes: number
    flags: { code: string; severity: string; tab: Tab }[]
}
const TABS: [Tab, string][] = [["models", "Models"], ["textures", "Textures"], ["animations", "Animations"], ["sounds", "Sounds"]]
const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)
export const scoreCls = (s: number) => (s >= 70 ? "text-emerald-300" : s >= 40 ? "text-amber-300" : "text-red-300")
export const sevCls = (s: string) => (s === "error" ? "bg-red-400/15 text-red-300" : s === "warn" ? "bg-amber-400/15 text-amber-300" : "bg-hover text-dim")

type Col = { key: string; label: string; get: (r: AssetRow) => number | string; show?: (r: AssetRow) => React.ReactNode }
const COMMON_HEAD: Col[] = [
    { key: "asset", label: "Asset", get: (r) => r.weaponId },
    { key: "pack", label: "Pack", get: (r) => r.pack },
    { key: "game", label: "Games", get: (r) => r.game },
]
const TAB_COLS: Record<Tab, Col[]> = {
    models: [
        { key: "tris", label: "Tris", get: (r) => r.tris, show: (r) => (r.hasModel ? r.tris.toLocaleString() : "no model") },
        { key: "verts", label: "Verts", get: (r) => r.verts, show: (r) => r.verts.toLocaleString() },
        { key: "mats", label: "Materials", get: (r) => r.materials },
    ],
    textures: [
        { key: "tex", label: "Textures", get: (r) => r.texCount },
        { key: "texmax", label: "Largest", get: (r) => r.texMax, show: (r) => (r.texMax ? `${r.texMax}px` : "-") },
        { key: "texbytes", label: "Size", get: (r) => r.texBytes, show: (r) => (r.texBytes ? kb(r.texBytes) : "-") },
        { key: "maps", label: "Maps", get: (r) => r.texMaps.length, show: (r) => r.texMaps.join(" ") || "-" },
    ],
    animations: [
        { key: "clips", label: "Clips", get: (r) => r.animCount },
        { key: "animlen", label: "Total length", get: (r) => r.animLen, show: (r) => (r.animLen ? `${r.animLen.toFixed(1)} s` : "-") },
    ],
    sounds: [
        { key: "snd", label: "Sounds", get: (r) => r.soundCount },
        { key: "sndlen", label: "Total length", get: (r) => r.soundLen, show: (r) => (r.soundLen ? `${r.soundLen.toFixed(1)} s` : "-") },
        { key: "sndbytes", label: "Size", get: (r) => r.soundBytes, show: (r) => (r.soundBytes ? kb(r.soundBytes) : "-") },
    ],
}

const tierColor = { fail: COLOR.bad, warn: COLOR.warn, pass: COLOR.good }
const rateColor = (r: number) => (r >= 0.7 ? COLOR.good : r >= 0.4 ? COLOR.warn : COLOR.bad)

/** Score distribution, pass share per pack and kind, flags of the current tab and the worst weapons. Clicking a mark
 *  narrows the table below through the same URL filters the dropdowns use. */
function AssetCharts({ rows, tab, set, trend }: { rows: AssetRow[]; tab: Tab; set: (o: Record<string, string>) => void; trend: PackTrend[] }) {
    const bins = scoreBins(rows)
    const packs = passByGroup(rows, (r) => r.pack)
    const kinds = passByGroup(rows, (r) => r.kind)
    const flags = flagCounts(rows, tab)
    const worst = worstOffenders(rows, 8)
    const pct = (x: { rate: number; pass: number; total: number }) => `${x.pass} of ${x.total} pass`
    return (
        <div className="mb-4 grid gap-3 lg:grid-cols-3">
            <Panel title="Score distribution" subtitle={`${rows.length} weapons by score 0-100. Click a bar to filter the table to that range.`} empty={rows.length === 0 && "No assets scanned yet."}
                legend={<Legend items={[{ label: "pass, 70 and up", color: COLOR.good }, { label: "warn, 40 to 69", color: COLOR.warn }, { label: "fail, under 40", color: COLOR.bad }]} />}>
                <StackedBars ariaLabel="Weapons per score band" unit="weapons" height={110}
                    bars={bins.map((b) => ({ key: `${b.lo}-${b.hi}`, label: `${b.label}`, segments: [{ key: b.tier, label: b.tier, value: b.count, color: tierColor[b.tier] }] }))}
                    onBar={(b) => { const [lo, hi] = b.key.split("-"); set({ min: lo, max: hi }) }} />
            </Panel>
            <Panel title="Pass share by pack" subtitle="Weapons at or above the pass score, per pack, weakest first. Click a pack to filter." empty={packs.length === 0 && "No packs."}>
                <BarList unit="%" onClick={(k) => set({ pack: k })} rows={packs.slice(0, 8).map((x) => ({ key: x.key, label: x.key, value: Math.round(x.rate * 100), color: rateColor(x.rate), note: pct(x) }))} max={100} />
            </Panel>
            <Panel title="Pass share by kind" subtitle="Same measure per weapon kind, weakest first." empty={kinds.length === 0 && "No kinds."}>
                <BarList unit="%" rows={kinds.slice(0, 8).map((x) => ({ key: x.key, label: x.key, value: Math.round(x.rate * 100), color: rateColor(x.rate), note: pct(x) }))} max={100} />
            </Panel>
            <Panel title={`Most common flags: ${tab}`} subtitle="Weapons carrying each quality flag on the current tab. Click a flag to filter." empty={flags.length === 0 && "No flags on this tab."}>
                <BarList unit="" onClick={(k) => set({ flag: k })} rows={flags.slice(0, 8).map((f) => ({ key: f.code, label: f.code, value: f.n, color: f.severity === "error" ? COLOR.bad : f.severity === "warn" ? COLOR.warn : COLOR.info, note: f.severity }))} />
            </Panel>
            <Panel title="Average score per audit" subtitle="One point per audit run, per pack. History starts at the first audit after this was added." empty={trend.length === 0 && "No audit history yet: it fills as audits are ingested."}>
                <ul className="space-y-1">
                    {trend.slice(0, 8).map((t) => (
                        <li key={t.pack} className="flex items-center justify-between gap-2 text-[12px]">
                            <span className="truncate text-dim">{t.pack}</span>
                            <span className="flex items-center gap-2"><Sparkline values={t.scores} label={`Average score of ${t.pack} per audit`} /><span className="tabular-nums text-fg">{t.last}</span></span>
                        </li>
                    ))}
                </ul>
            </Panel>
            <div className="lg:col-span-2">
                <Panel title="Worst offenders" subtitle="The eight lowest-scoring weapons. Click one to search for it." empty={worst.length === 0 && "Nothing scored."}>
                    <BarList unit="" max={100} onClick={(k) => set({ q: k })} rows={worst.map((r) => ({ key: r.weaponId, label: r.weaponId, value: r.score, color: rateColor(r.score / 100), note: `${r.pack}, ${r.kind}` }))} />
                </Panel>
            </div>
        </div>
    )
}

export type PackTrend = { pack: string; scores: number[]; last: number; total: number; pass: number }
export type KindInfo = { key: string; label: string }

export function Assets({ rows, kinds, sources, trend = [] }: { rows: AssetRow[]; kinds: KindInfo[]; sources: number; trend?: PackTrend[] }) {
    const router = useRouter()
    const path = usePathname()
    const sp = useSearchParams()
    const tab = (TABS.find(([t]) => t === sp.get("tab"))?.[0] ?? "models") as Tab
    const kind = sp.get("kind") ?? "", pack = sp.get("pack") ?? "", game = sp.get("game") ?? "", flag = sp.get("flag") ?? "", q = sp.get("q") ?? "", maxScore = sp.get("max") ?? "", minScore = sp.get("min") ?? ""
    const sort = sp.get("sort") ?? "score", dir = sp.get("dir") === "desc" ? -1 : 1
    const set = (o: Record<string, string>) => { const n = new URLSearchParams(sp.toString()); for (const [k, v] of Object.entries(o)) v ? n.set(k, v) : n.delete(k); router.replace(`${path}?${n}`, { scroll: false }) }
    const packs = [...new Set(rows.map((r) => r.pack))].sort()
    const games = [...new Set(rows.flatMap((r) => r.game.split(",").filter(Boolean)))].sort()
    const inKind = rows.filter((r) => !kind || r.kind === kind)
    const flagCodes = [...new Set(inKind.flatMap((r) => r.flags.filter((f) => f.tab === tab).map((f) => f.code)))].sort()
    const cols = [...COMMON_HEAD, ...TAB_COLS[tab]]
    const shown = useMemo(() => {
        const c = [...cols, { key: "score", label: "Score", get: (r: AssetRow) => r.score }].find((x) => x.key === sort)
        const f = rows.filter((r) =>
            (!kind || r.kind === kind) && (!pack || r.pack === pack) && (!game || r.game.split(",").includes(game)) && (!flag || r.flags.some((x) => x.code === flag)) &&
            (!q || r.weaponId.toLowerCase().includes(q.toLowerCase())) && (!minScore || r.score >= Number(minScore)) && (!maxScore || r.score <= Number(maxScore)))
        return f.sort((a, b) => { const x = c?.get(a) ?? 0, y = c?.get(b) ?? 0; return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * dir || a.weaponId.localeCompare(b.weaponId) })
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rows, tab, kind, pack, game, flag, q, minScore, maxScore, sort, dir])
    const sel = "rounded-md border border-line bg-panel px-2 py-1 text-[12px]"
    const th = (key: string, label: string) => (
        <th key={key} className="cursor-pointer select-none px-2 py-1 text-left font-medium text-dim hover:text-fg" onClick={() => set({ sort: key, dir: sort === key && dir === 1 ? "desc" : "asc" })}>
            {label}{sort === key ? (dir === 1 ? " ▲" : " ▼") : ""}
        </th>
    )
    const audited = rows.filter((r) => r.source === "audit").length
    if (!rows.length && !sources) return <FirstRun />
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">Assets <span className="text-muted">(RSI)</span></h1>
            <p className="mt-0.5 mb-3 text-[12px] text-muted">
                Every model of every source (packs and games): model, textures, animations and sounds with quality flags and a score, judged against the budget of its kind. {rows.length} assets, {audited} audited, the rest listed from a directory scan
                (<code className="font-mono">nightly assets scan</code>; audits arrive with <code className="font-mono">nightly assets ingest audit.json</code> or POST /api/assets/ingest). <Link className="text-sky-300 hover:underline" href="/assets/sources">Sources and kinds</Link>
            </p>
            <AssetCharts rows={rows} tab={tab} set={set} trend={trend} />
            <div className="mb-2 flex flex-wrap gap-1.5">
                {[{ key: "", label: "All" }, ...kinds.filter((k) => rows.some((r) => r.kind === k.key)), ...[...new Set(rows.map((r) => r.kind))].filter((k) => !kinds.some((x) => x.key === k)).map((k) => ({ key: k, label: k }))].map((k) => (
                    <button key={k.key} onClick={() => set({ kind: k.key, flag: "" })} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${k.key === kind ? "border-sky-400 text-fg" : "border-line text-dim hover:text-fg"}`}>
                        {k.label} <span className="text-[11px] text-muted">{k.key ? rows.filter((r) => r.kind === k.key).length : rows.length}</span>
                    </button>
                ))}
            </div>
            <div className="mb-3 flex gap-1 border-b border-line">
                {TABS.map(([t, l]) => (
                    <button key={t} onClick={() => set({ tab: t === "models" ? "" : t, flag: "", sort: "", dir: "" })} className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] ${t === tab ? "border-sky-400 text-fg" : "border-transparent text-dim hover:text-fg"}`}>
                        {l} <span className="text-[11px] text-muted">{rows.filter((r) => (t === "models" ? r.hasModel : t === "textures" ? r.texCount : t === "animations" ? r.animCount : r.soundCount)).length}</span>
                    </button>
                ))}
            </div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <input className={sel} placeholder="search asset" value={q} onChange={(e) => set({ q: e.target.value })} />
                <select className={sel} value={pack} onChange={(e) => set({ pack: e.target.value })}><option value="">all packs</option>{packs.map((p) => <option key={p}>{p}</option>)}</select>
                <select className={sel} value={game} onChange={(e) => set({ game: e.target.value })}><option value="">all games</option>{games.map((p) => <option key={p}>{p}</option>)}</select>
                <select className={sel} value={flag} onChange={(e) => set({ flag: e.target.value })}><option value="">any flag</option>{flagCodes.map((p) => <option key={p}>{p}</option>)}</select>
                <label className="text-[12px] text-dim">score <input className={`${sel} w-14`} placeholder="min" value={minScore} onChange={(e) => set({ min: e.target.value })} /> <input className={`${sel} w-14`} placeholder="max" value={maxScore} onChange={(e) => set({ max: e.target.value })} /></label>
                <span className="text-[12px] text-muted">{shown.length} shown</span>
            </div>
            <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-[12.5px]">
                    <thead className="border-b border-line bg-panel/60"><tr>{cols.map((c) => th(c.key, c.label))}{th("score", "Score")}<th className="px-2 py-1 text-left font-medium text-dim">Flags</th></tr></thead>
                    <tbody>
                        {shown.map((r) => (
                            <tr key={r.id} className="border-b border-line/50 hover:bg-hover/40">
                                <td className="px-2 py-1"><Link className="text-sky-300 hover:underline" href={`/assets/${r.id}`}>{r.weaponId}</Link>{r.source !== "audit" && <span className="ml-1 text-[10px] text-muted" title="from a directory scan, not yet audited">scan</span>}</td>
                                <td className="px-2 py-1 text-dim">{r.pack}</td>
                                <td className="px-2 py-1 text-dim">{r.game || "-"}</td>
                                {TAB_COLS[tab].map((c) => <td key={c.key} className="px-2 py-1 tabular-nums">{c.show ? c.show(r) : String(c.get(r))}</td>)}
                                <td className={`px-2 py-1 tabular-nums ${scoreCls(r.score)}`}>{r.score}</td>
                                <td className="px-2 py-1">{r.flags.filter((f) => f.tab === tab).map((f) => <span key={f.code} className={`mr-1 rounded px-1 text-[10.5px] ${sevCls(f.severity)}`}>{f.code}</span>)}</td>
                            </tr>
                        ))}
                        {!shown.length && <tr><td colSpan={cols.length + 2} className="px-2 py-6 text-center text-muted">Nothing matches the filters.</td></tr>}
                    </tbody>
                </table>
            </div>
        </div>
    )
}

function FirstRun() {
    return (
        <div className="mx-auto max-w-2xl px-6 py-10 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">Assets <span className="text-muted">(RSI)</span></h1>
            <div className="mt-4 rounded-lg border border-line bg-panel/60 p-5">
                <div className="text-[14px] font-medium">Add your first source</div>
                <p className="mt-1 text-[12.5px] text-dim">A source is a directory with the models, textures and sounds of one asset pack or game. Nightly scans it, lists every model by kind (prop, avatar, weapon, vehicle and so on), checks it against the budget of its kind and puts the findings on the RSI board.</p>
                <ol className="mt-3 list-decimal space-y-1 pl-5 text-[12.5px] text-dim">
                    <li>Add a source with its root directory, here or with <code className="font-mono">nightly assets source add my-game --type game --root /path/to/game</code>.</li>
                    <li>Scan it: <code className="font-mono">nightly assets scan</code>.</li>
                    <li>Adjust kinds and budgets if your game needs different limits.</li>
                </ol>
                <Link href="/assets/sources" className="mt-4 inline-block rounded-md border border-sky-400 px-3 py-1.5 text-[13px] text-sky-300 hover:bg-hover">Add a source</Link>
            </div>
        </div>
    )
}
