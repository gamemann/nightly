import { Suspense } from "react"
import { notFound } from "next/navigation"
import { AssetDetail, type AttachLink, type DetailData, type ReviewHit } from "~/components/AssetDetail"
import { AssetSources } from "~/components/AssetSources"
import { AssetCoverage } from "~/components/AssetCoverage"
import { AssetManager } from "~/components/tools/AssetManager"
import { Assets, type PackTrend } from "~/components/Assets"
import { parsePage } from "~/lib/paging"
import { ASSET_SPEC, assetAgg, assetPage } from "~/server/assetsList"
import { assetCoverage } from "~/server/assetsCoverage"
import { db } from "~/server/db"
import { ensureAssetNameRules } from "~/server/namingRules"
import { describe } from "../../../../../../lib/asset-names.mjs"
import { load } from "../../../../../../lib/review.mjs"
import { guard } from '~/server/pageGuard'

export const dynamic = "force-dynamic"

type Rec = { _files?: { glb?: string } } & Record<string, unknown>

export default async function AssetsPage({ params, searchParams }: { params: Promise<{ slug?: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const no = await guard('tools.view')
    if (no) return no
    const { slug = [] } = await params
    if (slug[0] === "sources") return <Suspense><AssetSources /></Suspense>
    if (slug[0] === "coverage") return <AssetManager><AssetCoverage data={await assetCoverage()} /></AssetManager>
    if (!slug[0]) {
        const q = parsePage(await searchParams, ASSET_SPEC)
        const [data, agg] = await Promise.all([assetPage(q), assetAgg()])
        const hist = await db.assetAuditHistory.findMany({ orderBy: [{ at: "asc" }, { id: "asc" }] })
        const byPack = new Map<string, typeof hist>()
        for (const h of hist) byPack.set(h.pack, [...(byPack.get(h.pack) ?? []), h])
        const trend: PackTrend[] = [...byPack].map(([pack, hs]) => ({ pack, scores: hs.slice(-30).map((h) => h.avgScore), last: hs[hs.length - 1].avgScore, total: hs[hs.length - 1].total, pass: hs[hs.length - 1].pass })).sort((a, b) => a.last - b.last)
        const [kinds, sources] = await Promise.all([db.assetKind.findMany({ orderBy: [{ sort: "asc" }, { key: "asc" }], select: { key: true, label: true, tab: true } }), db.assetSource.count()])
        return <AssetManager><Assets data={data} agg={agg} kinds={kinds} sources={sources} trend={trend} packNames={agg.packs.map((x) => x.key).sort()} /></AssetManager>
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
    const [kindRow] = await Promise.all([db.assetKind.findUnique({ where: { key: row.kind }, select: { tab: true } }), ensureAssetNameRules(db)])
    const files = _files as { glb?: string; textures?: unknown[]; sounds?: unknown[] } | undefined
    const [mine, fits] = await Promise.all([
        db.assetAttachment.findMany({ where: { parentId: row.id }, include: { attachment: { select: { id: true, pack: true, weaponId: true, tris: true, hasModel: true } } }, orderBy: [{ slot: "asc" }, { id: "asc" }] }),
        db.assetAttachment.findMany({ where: { attachmentId: row.id }, include: { parent: { select: { id: true, pack: true, weaponId: true, tris: true, hasModel: true } } }, orderBy: [{ slot: "asc" }, { id: "asc" }] }),
    ])
    const link = (l: (typeof mine)[number] | (typeof fits)[number], other: { id: number; pack: string; weaponId: string; tris: number; hasModel: number }): AttachLink => ({
        slot: l.slot, pos: [l.px, l.py, l.pz], rot: [l.rx, l.ry, l.rz], scale: [l.sx, l.sy, l.sz], node: l.node, meta: JSON.parse(l.meta || "{}") as Record<string, unknown>,
        other: { id: other.id, pack: other.pack, weaponId: other.weaponId, tris: other.tris, hasModel: other.hasModel === 1 },
    })
    const d: DetailData = {
        attachments: mine.map((l) => link(l, l.attachment)), fits: fits.map((l) => link(l, l.parent)),
        id: row.id, pack: row.pack, game: row.game, weaponId: row.weaponId, display: describe(row.pack, row.weaponId).name, kind: row.kind, tab: kindRow?.tab ?? "", source: row.source, score: row.score, pass: row.pass === 1, auditedAt: row.auditedAt,
        hasModel: !!files?.glb, data: data as DetailData["data"],
    }
    return <AssetDetail d={d} reviews={reviews} />
}
