"use client"
import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { BarList, Sparkline } from "./PerfChart"
import { Legend, Panel, StackedBars } from "./Charts"
import { DataTable, type Column } from "./DataTable"
import { useUrlParams } from "./Pagination"
import { COLOR } from "../../lib/charts.mjs"
import { ENTITY_KINDS, describe } from "../../lib/asset-names.mjs"
import type { Paged } from "~/lib/paging"
import type { Agg, AssetRow, Tab } from "~/server/assetsList"

export type { AssetRow, Tab }
const TABS: [Tab, string][] = [["entities", "Entities"], ["models", "Models"], ["maps", "Maps"], ["textures", "Textures"], ["animations", "Animations"], ["sounds", "Sounds"], ["libraries", "Libraries"]]
const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`)
export const scoreCls = (s: number) => (s >= 70 ? "text-emerald-300" : s >= 40 ? "text-amber-300" : "text-red-300")
export const sevCls = (s: string) => (s === "error" ? "bg-red-400/15 text-red-300" : s === "warn" ? "bg-amber-400/15 text-amber-300" : "bg-hover text-dim")

/** Cached preview (texture: downscaled image; model and animation: rendered model). Fixed box so nothing shifts, lazy, with a
 *  placeholder that stays visible until the file exists (generate with `nightly assets thumbs`). */
function Thumb({ r, tab }: { r: AssetRow; tab: Tab }) {
    const [bad, setBad] = useState(false)
    const kind = tab === "textures" ? "tex" : tab === "sounds" ? "" : "model"
    const ok = r.id > 0 && (kind === "tex" ? r.texCount > 0 : kind === "model" ? r.hasModel : false)
    return (
        <span className="relative block h-[54px] w-[72px] overflow-hidden rounded bg-hover/60" aria-hidden={!ok || bad}>
            {ok && !bad && /* eslint-disable-next-line @next/next/no-img-element */ <img loading="lazy" width={72} height={54} alt="" className="absolute inset-0 h-full w-full object-contain" src={`/api/assets/thumb/${r.id}?k=${kind}&h=${r.fileHash}`} onError={() => setBad(true)} />}
        </span>
    )
}

/** Entities, maps and libraries show the model flags. */
const flagScope = (t: Tab): Tab => (t === "entities" || t === "maps" || t === "libraries" ? "models" : t)
const num = (v: number) => v.toLocaleString("en-GB")
const TAB_COLS: Record<Exclude<Tab, "entities">, Column<AssetRow>[]> = {
    libraries: [
        { key: "maps", label: "Pieces", sortable: true, className: "tabular-nums", render: (r) => num(r.pieces) },
        { key: "tris", label: "Tris", sortable: true, className: "tabular-nums", render: (r) => num(r.tris) },
        { key: "tex", label: "Textures", sortable: true, className: "tabular-nums", render: (r) => num(r.texCount) },
        { key: "worst", label: "Worst", sortable: true, className: "tabular-nums", render: (r) => <span className={scoreCls(r.worst)}>{r.worst}</span> },
    ],
    maps: [
        { key: "maps", label: "Pieces", sortable: true, className: "tabular-nums", render: (r) => num(r.pieces) },
        { key: "tris", label: "Tris", sortable: true, className: "tabular-nums", render: (r) => num(r.tris) },
        { key: "tex", label: "Textures", sortable: true, className: "tabular-nums", render: (r) => num(r.texCount) },
        { key: "texbytes", label: "Tex size", sortable: true, className: "tabular-nums", render: (r) => (r.texBytes ? kb(r.texBytes) : "-") },
        { key: "worst", label: "Worst", sortable: true, className: "tabular-nums", render: (r) => <span className={scoreCls(r.worst)}>{r.worst}</span> },
    ],
    models: [
        { key: "tris", label: "Tris", sortable: true, className: "tabular-nums", render: (r) => (r.hasModel ? num(r.tris) : "no model") },
        { key: "verts", label: "Verts", sortable: true, className: "tabular-nums", render: (r) => num(r.verts) },
        { key: "mats", label: "Materials", sortable: true, className: "tabular-nums", render: (r) => r.materials },
    ],
    textures: [
        { key: "tex", label: "Textures", sortable: true, className: "tabular-nums", render: (r) => r.texCount },
        { key: "texmax", label: "Largest", sortable: true, className: "tabular-nums", render: (r) => (r.texMax ? `${r.texMax}px` : "-") },
        { key: "texbytes", label: "Size", sortable: true, className: "tabular-nums", render: (r) => (r.texBytes ? kb(r.texBytes) : "-") },
        { key: "maps", label: "Maps", sortable: true, render: (r) => r.texMaps.join(" ") || "-" },
    ],
    animations: [
        { key: "clips", label: "Clips", sortable: true, className: "tabular-nums", render: (r) => r.animCount },
        { key: "animlen", label: "Total length", sortable: true, className: "tabular-nums", render: (r) => (r.animLen ? `${r.animLen.toFixed(1)} s` : "-") },
    ],
    sounds: [
        { key: "snd", label: "Sounds", sortable: true, className: "tabular-nums", render: (r) => r.soundCount },
        { key: "sndlen", label: "Total length", sortable: true, className: "tabular-nums", render: (r) => (r.soundLen ? `${r.soundLen.toFixed(1)} s` : "-") },
        { key: "sndbytes", label: "Size", sortable: true, className: "tabular-nums", render: (r) => (r.soundBytes ? kb(r.soundBytes) : "-") },
    ],
}

const tierColor = { fail: COLOR.bad, warn: COLOR.warn, pass: COLOR.good }
const rateColor = (r: number) => (r >= 0.7 ? COLOR.good : r >= 0.4 ? COLOR.warn : COLOR.bad)

/** Score distribution, pass share per pack and kind, flags of the current tab and the worst weapons. Clicking a mark
 *  narrows the table below through the same URL filters the dropdowns use. */
function AssetCharts({ agg, tab, set, trend }: { agg: Agg; tab: Tab; set: (o: Record<string, string>) => void; trend: PackTrend[] }) {
    const { bins, packs, kinds, worst } = agg
    const router = useRouter()
    const flags = agg.flags.filter((f) => f.tab === flagScope(tab))
    const pct = (x: { rate: number; pass: number; total: number }) => `${x.pass} of ${x.total} pass`
    return (
        <div className="mb-4 grid gap-3 lg:grid-cols-3">
            <Panel title="Score distribution" subtitle={`${agg.total} weapons by score 0-100. Click a bar to filter the table to that range.`} empty={agg.total === 0 && "No assets scanned yet."}
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
                <Panel title="Worst offenders" subtitle="The eight lowest-scoring weapons. Click one to open it." empty={worst.length === 0 && "Nothing scored."}>
                    <BarList unit="" max={100} onClick={(k) => router.push(`/assets/${k}`)} rows={worst.map((r) => ({ key: String(r.id), label: `${describe(r.pack, r.weaponId).name} · ${r.pack}`, value: r.score, color: rateColor(r.score / 100), note: `${r.pack}, ${r.kind}` }))} />
                </Panel>
            </div>
        </div>
    )
}

export type PackTrend = { pack: string; scores: number[]; last: number; total: number; pass: number }
export type KindInfo = { key: string; label: string }

export function Assets({ data, agg, kinds, sources, trend = [], packNames }: { data: Paged<AssetRow>; agg: Agg; kinds: KindInfo[]; sources: number; trend?: PackTrend[]; packNames: string[] }) {
    const { sp, set } = useUrlParams()
    const params = useSearchParams()
    const tab = (TABS.find(([t]) => t === params.get("tab"))?.[0] ?? "entities") as Tab
    const kind = sp.get("kind") ?? ""
    const sort = sp.get("sort") ?? "score", dir = sp.get("dir") === "desc" ? "desc" : "asc"
    const q = sp.get("q") ?? ""
    const pieces = sp.get("pieces") === "1"
    const placeTab = tab === "maps" || tab === "libraries"
    const mapRows = placeTab && !pieces
    const flagCodes = [...new Set(agg.flags.filter((f) => f.tab === flagScope(tab)).map((f) => f.code))].sort()
    const inTab = (k: string) => tab === "entities" ? ENTITY_KINDS.includes(k) : tab === "models" ? !ENTITY_KINDS.includes(k) : true
    const kindList = [{ key: "", label: "All" }, ...kinds.filter((k) => agg.kinds.some((x) => x.key === k.key) && inTab(k.key)), ...agg.kinds.filter((k) => !kinds.some((x) => x.key === k.key) && inTab(k.key)).map((k) => ({ key: k.key, label: k.key }))]
    const allCount = tab === "entities" || tab === "models" ? agg.kinds.filter((x) => inTab(x.key)).reduce((a, x) => a + x.total, 0) : agg.total
    const cols: Column<AssetRow>[] = [
        { key: "thumb", label: "", render: (r) => <Thumb r={r} tab={tab} /> },
        { key: "asset", label: mapRows ? (tab === "maps" ? "Map" : "Library set") : "Asset", sortable: true, render: (r) => <><Link className="text-sky-300 hover:underline" href={r.id > 0 ? `/assets/${r.id}` : `/assets?tab=${tab}&pieces=1&grp=${encodeURIComponent(r.groupKey)}`} title={r.weaponId}>{r.display}</Link>{r.id > 0 && r.group && <span className="ml-1.5 text-[11px] text-muted" title={r.weaponId}>{r.group}</span>}{r.id <= 0 && <span className="ml-1.5 text-[11px] text-muted">{r.pieces} pieces</span>}{r.id > 0 && r.hasModel && r.texCount === 0 && <span className="ml-1 rounded bg-bad/20 px-1 text-[10px] text-bad" title="the model has no texture at all (flag NO_TEXTURES)">no texture</span>}{r.copies > 1 && <span className="ml-1 text-[10px] text-muted" title={r.uses.join(", ")}>x{r.copies}</span>}{r.source !== "audit" && <span className="ml-1 text-[10px] text-muted" title="from a directory scan, not yet audited">scan</span>}</> },
        { key: "pack", label: "Pack", sortable: true, className: "text-dim", render: (r) => r.pack },
        { key: "game", label: "Games", sortable: true, className: "text-dim", render: (r) => <span title={r.uses.join(", ")}>{r.game || (r.uses.length > 3 ? `${r.uses.slice(0, 2).join(", ")} +${r.uses.length - 2}` : r.uses.join(", ")) || "-"}</span> },
        ...(placeTab && pieces ? TAB_COLS.models : TAB_COLS[tab === "entities" ? "models" : tab]),
        { key: "score", label: mapRows ? "Mean" : "Score", sortable: true, className: "tabular-nums", render: (r) => <span className={scoreCls(r.score)}>{r.score}</span> },
        { key: "flags", label: "Flags", render: (r) => <>{r.flags.filter((f) => f.tab === flagScope(tab)).map((f) => <span key={f.code} className={`mr-1 rounded px-1 text-[10.5px] ${sevCls(f.severity)}`}>{f.code}</span>)}</> },
    ]
    if (!agg.total && !sources) return <FirstRun />
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">Assets <span className="text-muted">(RSI)</span></h1>
            <p className="mt-0.5 mb-3 text-[12px] text-muted">
                Every model of every source (packs and games): model, textures, animations and sounds with quality flags and a score, judged against the budget of its kind. {agg.total.toLocaleString("en-GB")} assets, {agg.audited.toLocaleString("en-GB")} audited, the rest listed from a directory scan
                (<code className="font-mono">nightly assets scan</code>; audits arrive with <code className="font-mono">nightly assets ingest audit.json</code> or POST /api/assets/ingest). Previews come from <code className="font-mono">nightly assets thumbs</code>. <Link className="text-sky-300 hover:underline" href="/assets/sources">Sources and kinds</Link>
            </p>
            <AssetCharts agg={agg} tab={tab} set={set} trend={trend} />
            <div className="mb-2 flex flex-wrap gap-1.5" hidden={placeTab}>
                {kindList.map((k) => (
                    <button key={k.key} onClick={() => set({ kind: k.key, flag: "" })} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${k.key === kind ? "border-sky-400 text-fg" : "border-line text-dim hover:text-fg"}`}>
                        {k.label} <span className="text-[11px] text-muted">{k.key ? agg.kinds.find((x) => x.key === k.key)?.total ?? 0 : allCount}</span>
                    </button>
                ))}
            </div>
            <div className="mb-3 flex gap-1 border-b border-line">
                {TABS.map(([t, l]) => (
                    <button key={t} onClick={() => set({ tab: t === "entities" ? "" : t, flag: "", sort: "", dir: "", pieces: "", grp: "", kind: "" })} className={`-mb-px border-b-2 px-3 py-1.5 text-[13px] ${t === tab ? "border-sky-400 text-fg" : "border-transparent text-dim hover:text-fg"}`}>
                        {l} <span className="text-[11px] text-muted">{agg.tabCounts[t]}</span>
                    </button>
                ))}
            </div>
            <DataTable cols={cols} data={data} rowKey={(r) => r.id} sort={sort} dir={dir} q={q} searchHint="Search asset or pack"
                active={{ pack: sp.get("pack") ?? "", game: sp.get("game") ?? "", flag: sp.get("flag") ?? "" }}
                filters={[
                    { key: "pack", label: "Pack", options: packNames.map((p) => ({ value: p })) },
                    { key: "game", label: "Game", options: agg.games.map((p) => ({ value: p })) },
                    { key: "flag", label: "Flag", options: flagCodes.map((p) => ({ value: p })) },
                ]}
                toolbar={<>{placeTab && pieces && <button className="mr-3 rounded-md border border-line px-2 py-1 text-[12px] text-sky-300 hover:bg-hover" onClick={() => set({ pieces: "", grp: "" })}>back to {tab}{sp.get("grp") ? ` (${sp.get("grp")})` : ""}</button>}<label className="text-[12px] text-dim">score <input className="w-14 rounded-md border border-line bg-panel px-2 py-1 text-[12px]" placeholder="min" defaultValue={sp.get("min") ?? ""} onBlur={(e) => set({ min: e.target.value })} /> <input className="w-14 rounded-md border border-line bg-panel px-2 py-1 text-[12px]" placeholder="max" defaultValue={sp.get("max") ?? ""} onBlur={(e) => set({ max: e.target.value })} /></label></>} />
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
