"use client"
import Link from "next/link"
import { useEffect, useRef, useState } from "react"
import { AssetViewer, type Mounted } from "./AssetViewer"
import { MapEditor } from "./MapEditor"
import { scoreCls, sevCls } from "./Assets"
import { describe } from "../../lib/asset-names.mjs"

const tabOf = (kind: string) => (["avatar", "npc", "monster", "character"].includes(kind) ? "avatars" : kind === "map" ? "maps" : "entities")
/** The asset list filtered by what was clicked: it reads pack, kind and game from the URL, and the tab follows the asset's kind. */
const listHref = (assetKind: string, f: Record<string, string>) => assetKind === "level" ? `/tools/maps?${new URLSearchParams(f)}` : `/tools/assets?${new URLSearchParams({ tab: tabOf(assetKind), ...f })}`

/** One attachment link seen from either end: `other` is the asset at the far end; pos (m), rot (degrees) and scale are in the weapon's model space. */
export type AttachLink = { slot: string; pos: number[]; rot: number[]; scale: number[]; node: string; meta: Record<string, unknown>; other: { id: number; pack: string; weaponId: string; tris: number; hasModel: boolean } }
export type DetailData = {
    attachments: AttachLink[]; fits: AttachLink[]
    id: number; pack: string; game: string; weaponId: string; kind: string; source: string; score: number; pass: boolean; auditedAt: string; hasModel: boolean
    data: {
        source_commit?: string; last_changed?: string
        model?: { glb?: string; viewer_glb?: string; tris?: number; verts?: number; materials?: number; meshes?: number; bbox?: number[]; primitive_meshes?: string[] }
        textures?: { name: string; w: number; h: number; format: string; bytes: number; maps?: string[]; pot?: boolean; embedded?: boolean }[]
        animations?: { name: string; length: number; tracks: number; flags?: string[]; mag_displacement?: number | null }[]
        sounds?: { name: string; len: number; rate: number; bytes: number; channels?: number; format?: string; event?: string; game?: string; kind?: string; synth?: string; file?: string; max_distance?: number; concurrent?: number; source?: string }[]
        compare?: { status: string; pack?: string; weapon_id?: string; diff?: string[] }
        flags?: { code: string; severity: string; msg: string }[]
        map?: { original?: { source?: string; tris?: number; surfaces?: number; error?: string; textured?: number; noTexture?: string[]; noTextureCount?: number }; layout: string; tris: number; surfaces: number; materials: number; textured: number; untextured: number; untexturedTris: number; missingTextures: string[]; missingTextureCount: number; mappedMaterials?: number; props?: number; propsPlaced?: number; propsMissing?: number; missingModels?: string[]; textureMb?: number; textureMax?: number; spawns: number; hulls: number; triggers: number; chunks: number; bounds?: { min: number[]; max: number[] } | null }
    }
}
export type ReviewHit = { key: string; title: string; verdict: string; note: string; media: { slot: string; variant: string; label: string; file: string; waveform?: string; strip?: string; poster?: string }[] }
const kb = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`)
const fileUrl = (id: number, kind: string, i: number) => `/api/assets/file/${id}/${kind}/${i}`
const mediaUrl = (key: string, file: string) => `/reviewmedia/${encodeURIComponent(key)}/${file.split("/").map(encodeURIComponent).join("/")}`

const nameOf = (id: string) => id.split("__").pop()!.replace(/^att_/, "").replace(/_/g, " ")
const fmt = (v: number[]) => v.map((n) => n.toFixed(3)).join(", ")

/** Attach any compatible attachment live: one per mount slot, several slots at once. The viewer parents each glb at the stored transform. */
function AttachPicker({ links, picked, setPicked }: { links: AttachLink[]; picked: Record<string, number>; setPicked: (p: Record<string, number>) => void }) {
    const slots = [...new Set(links.map((l) => l.slot))]
    return (
        <div data-testid="attach-picker" className="mt-3 rounded-lg border border-line bg-panel px-3 py-2">
            <div className="mb-1 flex items-center gap-2 text-[12px]"><span className="font-semibold text-fg">Attach</span><span className="text-muted">one per mount slot, several slots at once</span>
                {Object.keys(picked).length > 0 && <button className="ml-auto rounded bg-hover px-2 py-0.5 text-dim hover:text-fg" onClick={() => setPicked({})} data-testid="attach-clear">clear</button>}</div>
            <div className="grid gap-1.5">
                {slots.map((slot) => (
                    <div key={slot} className="flex flex-wrap items-center gap-1.5 text-[12px]" data-testid={`slot-${slot}`}>
                        <span className="w-24 text-muted">{slot}</span>
                        {links.map((l, i) => l.slot === slot && (
                            <button key={i} disabled={!l.other.hasModel} data-testid={`attach-${l.other.weaponId}`} title={l.other.hasModel ? `${l.other.weaponId} at ${fmt(l.pos)}` : "no model"}
                                onClick={() => { const n = { ...picked }; if (n[slot] === i) delete n[slot]; else n[slot] = i; setPicked(n) }}
                                className={`rounded-md px-2 py-0.5 ${picked[slot] === i ? "bg-sky-400/20 text-sky-200" : "bg-hover text-dim hover:text-fg disabled:opacity-40"}`}>{nameOf(l.other.weaponId)}</button>
                        ))}
                    </div>
                ))}
            </div>
        </div>
    )
}

function LinkTable({ links, title, mine }: { links: AttachLink[]; title: string; mine: boolean }) {
    return (
        <table className="w-full text-[12px]" data-testid="attach-table">
            <thead><tr className="text-left text-muted"><th className="py-1 pr-3 font-normal">{mine ? "attachment" : "weapon"}</th><th className="pr-3 font-normal">slot</th><th className="pr-3 font-normal">position (m)</th><th className="pr-3 font-normal">rotation (deg)</th><th className="font-normal">{title}</th></tr></thead>
            <tbody>{links.map((l, i) => (
                <tr key={i} className="border-t border-line">
                    <td className="py-1 pr-3"><Link href={`/tools/assets/${l.other.id}`} className="text-sky-300 hover:underline">{nameOf(l.other.weaponId)}</Link></td>
                    <td className="pr-3 text-dim">{l.slot}</td><td className="pr-3 font-mono text-dim">{fmt(l.pos)}</td><td className="pr-3 font-mono text-dim">{fmt(l.rot)}</td>
                    <td className="text-muted">{[l.node && `node ${l.node}`, l.meta.excludes && `excludes ${(l.meta.excludes as string[]).join(" ")}`, l.scale.some((n) => n !== 1) && `scale ${fmt(l.scale)}`].filter(Boolean).join(", ")}</td>
                </tr>))}</tbody>
        </table>
    )
}

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
    return <section id={id} className="mt-6"><h2 className="mb-2 text-[13px] font-semibold text-fg">{title}</h2>{children}</section>
}
const Stat = ({ k, v }: { k: string; v: React.ReactNode }) => <div className="rounded-md bg-panel px-2.5 py-1.5"><div className="text-[10.5px] uppercase tracking-wide text-muted">{k}</div><div className="text-[13px] tabular-nums">{v}</div></div>

function Waveform({ src }: { src: string }) {
    const c = useRef<HTMLCanvasElement>(null)
    useEffect(() => {
        let dead = false
        void (async () => {
            try {
                const buf = await (await fetch(src)).arrayBuffer()
                const ac = new AudioContext()
                const a = await ac.decodeAudioData(buf)
                void ac.close()
                const cv = c.current
                if (dead || !cv) return
                const g = cv.getContext("2d")!
                const ch = a.getChannelData(0)
                const step = Math.max(1, Math.floor(ch.length / cv.width))
                g.fillStyle = "#5eead4"
                for (let x = 0; x < cv.width; x++) {
                    let lo = 1, hi = -1
                    for (let i = x * step; i < Math.min(ch.length, (x + 1) * step); i++) { if (ch[i] < lo) lo = ch[i]; if (ch[i] > hi) hi = ch[i] }
                    g.fillRect(x, ((1 - hi) * cv.height) / 2, 1, Math.max(1, ((hi - lo) * cv.height) / 2))
                }
            } catch { /* undecodable: the player still works */ }
        })()
        return () => { dead = true }
    }, [src])
    return <canvas ref={c} width={600} height={56} className="h-14 w-full rounded bg-panel" />
}

export function AssetDetail({ d, reviews }: { d: DetailData; reviews: ReviewHit[] }) {
    const x = d.data
    const [picked, setPicked] = useState<Record<string, number>>({})
    const mounted: Mounted[] = Object.entries(picked).map(([slot, i]) => { const l = d.attachments[i]; return { key: `${slot}:${l.other.id}`, url: fileUrl(l.other.id, "glb", 0), pos: l.pos, rot: l.rot, scale: l.scale } })
    const flags = x.flags ?? []
    const [big, setBig] = useState<number | null>(null)
    const texN = (x.textures ?? []).length
    const hasOrig = !!x.map?.original && !x.map.original.error
    const [view, setView] = useState<"converted" | "original">("converted")
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight"><Link href={d.kind === "level" ? "/tools/maps" : "/tools/assets"} className="hover:text-sky-300">{d.kind === "level" ? "Maps" : "Assets"}</Link> <span className="text-muted">/</span> <Link href={listHref(d.kind, { pack: d.pack })} className="hover:text-sky-300">{d.pack}</Link> <span className="text-muted">/</span> <span title={d.weaponId}>{describe(d.pack, d.weaponId).name}</span> <span className="font-mono text-[11px] font-normal text-muted">{d.weaponId}</span></h1>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px]">
                <span className={`text-[22px] font-semibold tabular-nums ${scoreCls(d.score)}`}>{d.score}</span>
                <span className={`rounded px-1.5 ${d.pass ? "bg-emerald-400/15 text-emerald-300" : "bg-red-400/15 text-red-300"}`}>{d.pass ? "pass" : "fail"}</span>
                <Link href={listHref(d.kind, { pack: d.pack, kind: d.kind })} title={`all ${d.kind} assets in ${d.pack}`} className="rounded bg-hover px-1.5 text-dim hover:text-sky-300">{d.kind}</Link>
                <span className="text-dim">games: {d.game ? d.game.split(",").map((g, i) => <span key={g}>{i > 0 && ","}<Link href={listHref(d.kind, { game: g.trim() })} className="hover:text-sky-300 hover:underline">{g.trim()}</Link></span>) : "-"}</span>
                <span className="text-dim">{d.source === "audit" ? `audited ${d.auditedAt.slice(0, 16).replace("T", " ")}` : `listed from a directory scan ${d.auditedAt.slice(0, 10)} (no audit yet)`}</span>
                {x.source_commit && <span className="font-mono text-muted">{x.source_commit}</span>}
                {x.last_changed && <span className="text-muted">changed {x.last_changed}</span>}
                <nav className="ml-auto flex gap-3 text-sky-300"><a href="#model">Model</a><a href="#textures">Textures</a><a href="#animations">Animations</a><a href="#sounds">Sounds</a></nav>
            </div>
            {!!flags.length && <div className="mt-2 flex flex-wrap gap-1.5">{flags.map((f) => <span key={f.code} title={f.msg} className={`rounded px-1.5 py-0.5 text-[11px] ${sevCls(f.severity)}`}>{f.code}: {f.msg}</span>)}</div>}

            {x.map && (
                <div className="mt-4 flex gap-1 border-b border-line text-[13px]">
                    {(["converted", "original"] as const).map((v) => <button key={v} onClick={() => setView(v)} data-testid={`tab-${v}`} className={`-mb-px border-b-2 px-3 py-1.5 capitalize ${view === v ? "border-sky-300 text-fg" : "border-transparent text-dim hover:text-fg"}`}>{v}{v === "original" && !hasOrig ? " (none)" : ""}</button>)}
                </div>
            )}
            {x.map && view === "original" ? <OriginalPane d={d} /> : <>
            <Section id="model" title="Model">
                {d.hasModel ? (x.map ? <MapModel d={d} x={x} /> : <AssetViewer url={fileUrl(d.id, "glb", 0)} mounted={mounted} bbox={x.model?.bbox} textures={(x.textures ?? []).map((t, i) => ({ name: t.name, url: fileUrl(d.id, "tex", i) }))} />) : <div className="rounded-lg border border-line p-6 text-center text-[12px] text-muted">No model file for this asset.</div>}
                {d.hasModel && !x.map && d.attachments.length > 0 && <AttachPicker links={d.attachments} picked={picked} setPicked={setPicked} />}
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                    <Stat k="triangles" v={(x.model?.tris ?? 0).toLocaleString("en-GB")} /><Stat k="vertices" v={(x.model?.verts ?? 0).toLocaleString("en-GB")} /><Stat k="materials" v={x.model?.materials ?? 0} /><Stat k="meshes" v={x.model?.meshes ?? 0} />
                    <Stat k="bbox (m)" v={(x.model?.bbox ?? []).map((v) => v.toFixed(2)).join(" x ") || "-"} /><Stat k="primitive meshes" v={(x.model?.primitive_meshes ?? []).length} />
                </div>
                {x.map && (
                    <div className="mt-2">
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                            <Stat k="surfaces" v={x.map.surfaces} /><Stat k="culling chunks" v={x.map.chunks} /><Stat k="spawns" v={x.map.spawns} /><Stat k="collision hulls" v={x.map.hulls} /><Stat k="trigger zones" v={x.map.triggers} />
                            <Stat k="untextured" v={`${x.map.untextured} of ${x.map.surfaces}`} />{x.map.original && <Stat k="original" v={x.map.original.error ? "failed" : `${x.map.original.source ?? ""} ${(x.map.original.tris ?? 0).toLocaleString("en-GB")} tris`} />}{x.map.props ? <Stat k="props placed" v={`${x.map.propsPlaced ?? 0} of ${x.map.props}`} /> : null}{x.map.textureMax ? <Stat k="texture budget" v={`${x.map.textureMax}px, ${x.map.textureMb} MB`} /> : null}
                        </div>
                        {(x.map.missingModels?.length ?? 0) > 0 && <div className="mt-2 text-[12px] text-dim"><span className="text-muted">props without a model ({x.map.propsMissing}): </span><span className="font-mono">{x.map.missingModels!.join(", ")}</span></div>}
                        {x.map.missingTextureCount > 0 && <div className="mt-2 text-[12px] text-dim"><span className="text-muted">materials without a texture file ({x.map.missingTextureCount}): </span><span className="font-mono">{x.map.missingTextures.join(", ")}{x.map.missingTextureCount > x.map.missingTextures.length ? ", ..." : ""}</span></div>}
                    </div>
                )}
                <div className="mt-1 font-mono text-[11px] text-muted">{x.model?.glb}{x.model?.viewer_glb ? ` (viewer: ${x.model.viewer_glb})` : ""}</div>
            </Section>

            {d.attachments.length > 0 && <Section id="attachments" title={`Attachments (${d.attachments.length})`}><LinkTable links={d.attachments} title="notes" mine /></Section>}
            {d.fits.length > 0 && <Section id="fits" title={`Fits (${d.fits.length} weapons)`}><LinkTable links={d.fits} title="notes" mine={false} /></Section>}
            <Section id="textures" title={`Textures (${texN})`}>
                {texN ? (
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                        {x.textures!.map((t, i) => (
                            <div key={i} className="rounded-lg border border-line bg-panel/40 p-2">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={fileUrl(d.id, "tex", i)} alt={t.name} loading="lazy" onClick={() => setBig(i)} className="h-32 w-full cursor-zoom-in rounded bg-[#222] object-contain" />
                                <div className="mt-1 truncate text-[12px]" title={t.name}>{t.name}</div>
                                <div className="text-[11px] text-dim">{t.w}x{t.h} {t.format} {kb(t.bytes)}{t.pot === false ? " NPOT" : ""}{t.embedded ? " embedded" : ""}</div>
                                <div className="mt-0.5 flex flex-wrap gap-1">{(t.maps ?? []).map((m) => <span key={m} className="rounded bg-hover px-1 text-[10.5px] text-dim">{m}</span>)}</div>
                            </div>
                        ))}
                    </div>
                ) : <div className="text-[12px] text-muted">No textures.</div>}
                {big !== null && x.textures && (
                    <div className="fixed inset-0 z-50 grid cursor-zoom-out place-items-center bg-black/80 p-6" onClick={() => setBig(null)}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={fileUrl(d.id, "tex", big)} alt="" className="max-h-full max-w-full bg-[#222] object-contain" />
                    </div>
                )}
            </Section>

            <Section id="animations" title={`Animations (${(x.animations ?? []).length})`}>
                {(x.animations ?? []).length ? (
                    <table className="w-full text-[12.5px]"><thead><tr className="border-b border-line text-left text-dim"><th className="px-2 py-1 font-medium">Clip</th><th className="px-2 py-1 font-medium">Length</th><th className="px-2 py-1 font-medium">Tracks</th><th className="px-2 py-1 font-medium">Mag travel</th><th className="px-2 py-1 font-medium">Flags</th></tr></thead>
                        <tbody>{x.animations!.map((a) => (
                            <tr key={a.name} className="border-b border-line/50"><td className="px-2 py-1">{a.name}</td><td className="px-2 py-1 tabular-nums">{a.length == null ? "-" : `${a.length.toFixed(2)} s`}</td><td className="px-2 py-1 tabular-nums">{a.tracks}</td><td className="px-2 py-1 tabular-nums">{a.mag_displacement == null ? "-" : `${a.mag_displacement.toFixed(3)} m`}</td>
                                <td className="px-2 py-1">{(a.flags ?? []).map((f) => <span key={f} className={`mr-1 rounded px-1 text-[10.5px] ${/static|no_tracks/.test(f) ? "bg-amber-400/15 text-amber-300" : "bg-hover text-dim"}`}>{f}</span>)}</td></tr>))}</tbody></table>
                ) : <div className="text-[12px] text-muted">The model carries no animation clips.</div>}
                <ReviewMedia reviews={reviews} slots={["filmstrip", "clip", "image", "screenshot"]} />
            </Section>

            {x.compare && (
                <div className="mt-3 rounded-lg border border-line bg-panel/40 p-2 text-[12px]">
                    <span className="font-medium">Game-local copy</span>{" "}
                    {x.compare.pack ? <span className="text-dim">same asset id as {x.compare.pack}/{x.compare.weapon_id}{x.compare.diff?.length ? `, differs: ${x.compare.diff.join(", ")}` : ", identical stats"}</span> : <span className="text-dim">{x.compare.status}: no pack carries this asset id</span>}
                </div>
            )}

            <Section id="sounds" title={`Sounds (${(x.sounds ?? []).length})`}>
                {(x.sounds ?? []).length ? (
                    <div className="space-y-2">{x.sounds!.map((s, i) => (
                        s.event ? (
                        <div key={i} className="rounded-lg border border-line bg-panel/40 p-2 text-[12px]">
                            <div className="flex flex-wrap items-baseline gap-x-3"><span className="rounded bg-sky-400/15 px-1.5 text-sky-300">event</span><span className="font-medium">{s.name}</span><span className="font-mono text-dim">{s.event}</span><span className="text-dim">{s.game} / {s.kind}</span></div>
                            <div className="mt-1 text-dim">{s.synth ? `synthesised: ${s.synth}` : s.file ? `file: ${s.file}` : "no file"}{s.max_distance ? `, audible ${s.max_distance} m` : ""}{s.concurrent ? `, ${s.concurrent} voices` : ""}</div>
                            {s.source && <div className="font-mono text-[11px] text-muted">{s.source}</div>}
                        </div>) :
                        <div key={i} className="rounded-lg border border-line bg-panel/40 p-2">
                            <div className="mb-1 flex flex-wrap items-baseline gap-x-3 text-[12px]"><span className="font-medium">{s.name}</span><span className="tabular-nums text-dim">{(s.len ?? 0).toFixed(2)} s, {s.rate} Hz{s.channels ? `, ${s.channels} ch` : ""}, {kb(s.bytes)}</span></div>
                            <Waveform src={fileUrl(d.id, "snd", i)} />
                            <audio controls preload="none" src={fileUrl(d.id, "snd", i)} className="mt-1 h-8 w-full" />
                        </div>))}</div>
                ) : <div className="text-[12px] text-muted">No sounds matched to this asset.</div>}
                <ReviewMedia reviews={reviews} slots={["audio"]} />
            </Section>

            <Section id="reviews" title="Review verdicts">
                {reviews.length ? reviews.map((r) => (
                    <div key={r.key} className="mb-2 rounded-lg border border-line p-2 text-[12.5px]">
                        <Link href={`/item/${r.key}`} className="text-sky-300 hover:underline">{r.title}</Link>{" "}
                        <span className={`rounded px-1.5 text-[11px] ${r.verdict === "good" ? "bg-emerald-400/15 text-emerald-300" : r.verdict === "wrong" ? "bg-red-400/15 text-red-300" : "bg-hover text-dim"}`}>{r.verdict === "wrong" ? "still wrong" : r.verdict || "not reviewed"}</span>
                        {r.note && <p className="mt-1 whitespace-pre-wrap text-dim">{r.note}</p>}
                    </div>)) : <div className="text-[12px] text-muted">No review item mentions this asset.</div>}
            </Section>
            </>}
        </div>
    )
}

type OrigInfo = { materials: { name: string; color: number[] | null }[]; meshes: number; nodes: number; images: number; error?: string }
/** Maps: the editor-style inspector (default) or the side-by-side compare viewer (converted / original / split). */
function MapModel({ d, x }: { d: DetailData; x: DetailData["data"] }) {
    const [mode, setMode] = useState<"editor" | "compare">("editor")
    const orig = x.map?.original && !x.map.original.error ? fileUrl(d.id, "orig", 0) : undefined
    return (
        <div>
            <div className="mb-2 flex gap-1 text-[12px]">
                {(["editor", "compare"] as const).map((m) => <button key={m} onClick={() => setMode(m)} data-testid={`maptab-${m}`} className={`rounded border px-2 py-0.5 capitalize ${mode === m ? "border-sky-300 text-fg" : "border-line text-dim hover:text-fg"}`}>{m === "compare" ? "Compare / fly" : "Editor"}</button>)}
            </div>
            {mode === "editor" ? <MapEditor url={fileUrl(d.id, "glb", 0)} /> : <AssetViewer url={fileUrl(d.id, "glb", 0)} bbox={x.model?.bbox} textures={(x.textures ?? []).map((t, i) => ({ name: t.name, url: fileUrl(d.id, "tex", i) }))} map original={orig} />}
        </div>
    )
}

function OriginalPane({ d }: { d: DetailData }) {
    const o = d.data.map?.original
    const [info, setInfo] = useState<OrigInfo | null>(null)
    const ok = !!o && !o.error
    useEffect(() => { if (ok) void fetch(`/api/assets/original/${d.id}`).then((r) => r.json()).then(setInfo).catch(() => setInfo({ materials: [], meshes: 0, nodes: 0, images: 0, error: "failed to load" })) }, [d.id, ok])
    if (!ok) return <div className="mt-4 rounded-lg border border-line p-6 text-center text-[12px] text-muted">{o?.error ? `The original failed to convert: ${o.error}` : "No original source map (BSP) was found for this map, so there is nothing to show."}</div>
    const hex = (c: number[] | null) => c ? `rgb(${c.slice(0, 3).map((v) => Math.round(Math.pow(Math.min(1, v), 1 / 2.2) * 255)).join(",")})` : "transparent"
    return (
        <>
            <Section id="orig-model" title="Original model">
                <AssetViewer url={fileUrl(d.id, "orig", 0)} map />
                <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-6">
                    <Stat k="source" v={o.source ?? "-"} /><Stat k="triangles" v={(o.tris ?? 0).toLocaleString("en-GB")} /><Stat k="surfaces" v={(o.surfaces ?? 0).toLocaleString("en-GB")} />
                    {info && <><Stat k="meshes" v={info.meshes} /><Stat k="source materials" v={info.materials.length} /></>}
                </div>
                <div className="mt-2 text-[12px] text-dim">Exported from the source BSP and textured with the images the converted map resolved for the same material names. Materials without a texture show a grey checker; tools/* are black or hidden as in the converted map.</div>
            </Section>
            {!!o.noTexture?.length && (
                <Section id="orig-notexture" title={`No texture available (${o.noTextureCount ?? o.noTexture.length})`}>
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">{o.noTexture.map((m) => <div key={m} className="truncate rounded bg-panel/40 px-2 py-1 text-[12px] text-dim" title={m}>{m}</div>)}</div>
                </Section>
            )}
            <Section id="orig-materials" title={`Original materials (${info?.materials.length ?? "..."})`}>
                {info?.error ? <div className="text-[12px] text-red-300">{info.error}</div> : info?.materials.length ? (
                    <div className="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3">{info.materials.map((m, i) => (
                        <div key={i} className="flex items-center gap-2 rounded bg-panel/40 px-2 py-1 text-[12px]"><span className="h-3 w-3 shrink-0 rounded-sm border border-line" style={{ background: hex(m.color) }} /><span className="truncate font-mono" title={m.name}>{m.name || "(unnamed)"}</span></div>))}</div>
                ) : <div className="text-[12px] text-muted">{info ? "No materials." : "Loading..."}</div>}
            </Section>
        </>
    )
}

function ReviewMedia({ reviews, slots }: { reviews: ReviewHit[]; slots: string[] }) {
    const items = reviews.flatMap((r) => r.media.filter((m) => slots.includes(m.slot)).map((m) => ({ ...m, key: r.key })))
    if (!items.length) return null
    return (
        <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-3">
            {items.map((m) => (
                <div key={`${m.key}${m.file}`} className="rounded-lg border border-line p-2">
                    {m.slot === "audio" ? (
                        <>
                            <audio controls preload="none" src={mediaUrl(m.key, m.file)} className="h-8 w-full" />
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            {m.waveform && <img src={mediaUrl(m.key, m.waveform)} alt="" className="mt-1 w-full rounded" />}
                        </>
                    ) : m.slot === "clip" ? (
                        <video controls preload="none" poster={m.poster ? mediaUrl(m.key, m.poster) : undefined} src={mediaUrl(m.key, m.file)} className="w-full rounded" />
                    ) : (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={mediaUrl(m.key, m.strip || m.file)} alt={m.label} loading="lazy" className="w-full rounded" />
                    )}
                    <div className="mt-1 text-[11px] text-dim">{m.slot}{m.variant ? ` ${m.variant}` : ""}: {m.label}</div>
                </div>))}
        </div>
    )
}
