import { notFound } from "next/navigation"
import { AssetDetail, type DetailData, type ReviewHit } from "~/components/AssetDetail"
import { AssetSources } from "~/components/AssetSources"
import { Assets, type AssetRow, type PackTrend } from "~/components/Assets"
import { db } from "~/server/db"
import { load } from "../../../../lib/review.mjs"

export const dynamic = "force-dynamic"

type Flag = { code: string; severity: string; msg: string }
type Rec = {
    model?: { glb?: string; tris?: number; verts?: number; materials?: number; bbox?: number[] }
    textures?: { w: number; h: number; bytes: number; maps?: string[] }[]
    animations?: { length: number }[]
    sounds?: { len: number; bytes: number }[]
    flags?: Flag[]
    _files?: { glb?: string }
}
/** Which tab a flag belongs to. */
function flagTab(code: string): "models" | "textures" | "animations" | "sounds" {
    if (/TEX|NORMAL|ORM/.test(code) && !/^NO_MODEL/.test(code)) return "textures"
    if (/CLIP|MAG|ANIM|ARMS|BOLT|CYCLE/.test(code)) return "animations"
    if (/SOUND/.test(code)) return "sounds"
    return "models"
}

export default async function AssetsPage({ params }: { params: Promise<{ slug?: string[] }> }) {
    const { slug = [] } = await params
    if (slug[0] === "sources") return <AssetSources />
    if (!slug[0]) {
        const rows = await db.assetWeapon.findMany({ orderBy: [{ pack: "asc" }, { weaponId: "asc" }] })
        const out: AssetRow[] = rows.map((r) => {
            const d = JSON.parse(r.data) as Rec
            const tex = d.textures ?? []
            const flags = d.flags ?? []
            return {
                id: r.id, pack: r.pack, game: r.game, weaponId: r.weaponId, kind: r.kind, source: r.source, score: r.score, pass: r.pass === 1, auditedAt: r.auditedAt,
                hasModel: !!d._files?.glb, tris: d.model?.tris ?? 0, verts: d.model?.verts ?? 0, materials: d.model?.materials ?? 0,
                texCount: tex.length, texMax: Math.max(0, ...tex.map((t) => Math.max(t.w, t.h))), texBytes: tex.reduce((n, t) => n + t.bytes, 0), texMaps: [...new Set(tex.flatMap((t) => t.maps ?? []))],
                animCount: (d.animations ?? []).length, animLen: (d.animations ?? []).reduce((n, a) => n + a.length, 0),
                soundCount: (d.sounds ?? []).length, soundLen: (d.sounds ?? []).reduce((n, s) => n + s.len, 0), soundBytes: (d.sounds ?? []).reduce((n, s) => n + s.bytes, 0),
                flags: flags.map((f) => ({ code: f.code, severity: f.severity, tab: flagTab(f.code) })),
            }
        })
        const hist = await db.assetAuditHistory.findMany({ orderBy: [{ at: "asc" }, { id: "asc" }] })
        const byPack = new Map<string, typeof hist>()
        for (const h of hist) byPack.set(h.pack, [...(byPack.get(h.pack) ?? []), h])
        const trend: PackTrend[] = [...byPack].map(([pack, hs]) => ({ pack, scores: hs.slice(-30).map((h) => h.avgScore), last: hs[hs.length - 1].avgScore, total: hs[hs.length - 1].total, pass: hs[hs.length - 1].pass })).sort((a, b) => a.last - b.last)
        const [kinds, sources] = await Promise.all([db.assetKind.findMany({ orderBy: [{ sort: "asc" }, { key: "asc" }], select: { key: true, label: true } }), db.assetSource.count()])
        return <Assets rows={out} kinds={kinds} sources={sources} trend={trend} />
    }
    const id = Number(slug[0])
    const row = Number.isInteger(id) ? await db.assetWeapon.findUnique({ where: { id } }) : null
    if (!row) notFound()
    const { _files, ...data } = JSON.parse(row.data) as Rec & Record<string, unknown>
    const reviews: ReviewHit[] = []
    const items = await db.item.findMany({ where: { kind: "review" }, orderBy: { id: "desc" }, take: 200, select: { key: true, title: true } })
    for (const it of items) {
        const w = load(it.key).weapons[row.weaponId]
        if (w) reviews.push({ key: it.key, title: it.title, verdict: w.verdict, note: w.note, media: w.media.map((m) => ({ slot: m.slot, variant: m.variant, label: m.label, file: m.file, waveform: m.waveform, strip: m.strip, poster: m.poster })) })
    }
    const files = _files as { glb?: string; textures?: unknown[]; sounds?: unknown[] } | undefined
    const d: DetailData = {
        id: row.id, pack: row.pack, game: row.game, weaponId: row.weaponId, kind: row.kind, source: row.source, score: row.score, pass: row.pass === 1, auditedAt: row.auditedAt,
        hasModel: !!files?.glb, data: data as DetailData["data"],
    }
    return <AssetDetail d={d} reviews={reviews} />
}
