import { notFound } from "next/navigation"
import { AssetDetail, type DetailData, type ReviewHit } from "~/components/AssetDetail"
import { AssetSources } from "~/components/AssetSources"
import { Assets, type PackTrend } from "~/components/Assets"
import { parsePage } from "~/lib/paging"
import { ASSET_SPEC, assetAgg, assetPage } from "~/server/assetsList"
import { db } from "~/server/db"
import { load } from "../../../../lib/review.mjs"

export const dynamic = "force-dynamic"

type Rec = { _files?: { glb?: string } } & Record<string, unknown>

export default async function AssetsPage({ params, searchParams }: { params: Promise<{ slug?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const { slug = [] } = await params
    if (slug[0] === "sources") return <AssetSources />
    if (!slug[0]) {
        const q = parsePage(await searchParams, ASSET_SPEC)
        const [data, agg] = await Promise.all([assetPage(q), assetAgg()])
        const hist = await db.assetAuditHistory.findMany({ orderBy: [{ at: "asc" }, { id: "asc" }] })
        const byPack = new Map<string, typeof hist>()
        for (const h of hist) byPack.set(h.pack, [...(byPack.get(h.pack) ?? []), h])
        const trend: PackTrend[] = [...byPack].map(([pack, hs]) => ({ pack, scores: hs.slice(-30).map((h) => h.avgScore), last: hs[hs.length - 1].avgScore, total: hs[hs.length - 1].total, pass: hs[hs.length - 1].pass })).sort((a, b) => a.last - b.last)
        const [kinds, sources] = await Promise.all([db.assetKind.findMany({ orderBy: [{ sort: "asc" }, { key: "asc" }], select: { key: true, label: true } }), db.assetSource.count()])
        return <Assets data={data} agg={agg} kinds={kinds} sources={sources} trend={trend} packNames={agg.packs.map((x) => x.key).sort()} />
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
