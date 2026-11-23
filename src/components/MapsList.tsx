"use client"
import Link from "next/link"
import { useMemo, useState } from "react"
import type { MapRow } from "~/server/mapsList"

const cls = (s: number) => (s >= 70 ? "text-emerald-300" : s >= 40 ? "text-amber-300" : "text-red-300")
type Key = "name" | "pack" | "tris" | "spawns" | "score"

/** The Maps page: every converted map; a row opens the map page with the fly-cam viewer. */
export function MapsList({ rows }: { rows: MapRow[] }) {
    const [q, setQ] = useState(""), [pack, setPack] = useState(""), [sort, setSort] = useState<Key>("name"), [desc, setDesc] = useState(false)
    const packs = useMemo(() => [...new Set(rows.map((r) => r.pack))].sort(), [rows])
    const shown = useMemo(() => {
        const n = q.trim().toLowerCase()
        const f = rows.filter((r) => (!pack || r.pack === pack) && (!n || r.name.toLowerCase().includes(n) || r.pack.toLowerCase().includes(n)))
        return f.sort((a, b) => { const x = a[sort], y = b[sort]; const c = typeof x === "string" ? x.localeCompare(String(y)) : Number(x) - Number(y); return desc ? -c : c })
    }, [rows, q, pack, sort, desc])
    const th = (k: Key, l: string) => <th className="cursor-pointer px-2 py-1 text-left font-normal text-muted hover:text-fg" onClick={() => { if (sort === k) setDesc(!desc); else { setSort(k); setDesc(false) } }}>{l}{sort === k ? (desc ? " ↓" : " ↑") : ""}</th>
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">Maps <span className="text-muted">{shown.length} of {rows.length}</span></h1>
            <p className="mt-1 text-[12.5px] text-dim">Every converted map. Open one for the fly-cam viewer (converted / original), its stats and quality flags. The map models are listed under <Link className="text-sky-300 hover:underline" href="/assets?tab=maps">Assets</Link>.</p>
            <div className="my-3 flex flex-wrap gap-2">
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search maps" className="rounded-md border border-line bg-transparent px-2 py-1 text-[13px]" />
                <select value={pack} onChange={(e) => setPack(e.target.value)} className="rounded-md border border-line bg-transparent px-2 py-1 text-[13px]"><option value="">All packs</option>{packs.map((p) => <option key={p} value={p}>{p}</option>)}</select>
            </div>
            <table className="w-full text-[13px]">
                <thead><tr className="border-b border-line">{th("name", "Map")}{th("pack", "Pack")}{th("tris", "Tris")}<th className="px-2 py-1 text-left font-normal text-muted">Surfaces</th>{th("spawns", "Spawns")}<th className="px-2 py-1 text-left font-normal text-muted">Original</th>{th("score", "Score")}<th className="px-2 py-1 text-left font-normal text-muted">Flags</th></tr></thead>
                <tbody>{shown.map((r) => (
                    <tr key={`${r.pack}/${r.name}`} className="border-b border-line/50 hover:bg-hover">
                        <td className="px-2 py-1.5">{r.gameMap ? <span title="Map definition only: no converted geometry to view yet">{r.title ?? r.name} <span className="rounded bg-hover px-1 text-[10.5px] text-dim">definition only</span></span> : <Link className="text-sky-300 hover:underline" href={`/maps/${r.id}`}>{r.name}</Link>}</td>
                        <td className="px-2 text-dim">{r.pack}</td><td className="px-2 tabular-nums">{r.gameMap ? "-" : r.tris.toLocaleString("en-GB")}</td><td className="px-2 tabular-nums">{r.surfaces}</td><td className="px-2 tabular-nums">{r.spawns}</td>
                        <td className="px-2 text-dim">{r.hasOriginal ? "yes" : "-"}</td><td className={`px-2 tabular-nums ${cls(r.score)}`}>{r.gameMap ? "-" : r.score}</td>
                        <td className="px-2">{r.flags.map((f) => <span key={f} className="mr-1 rounded bg-amber-400/15 px-1 text-[10.5px] text-amber-300">{f}</span>)}</td>
                    </tr>
                ))}</tbody>
            </table>
            {!shown.length && <p className="py-6 text-dim">No maps yet. Scan a map source: <code className="font-mono">nightly assets scan &lt;pack&gt;</code>.</p>}
        </div>
    )
}
