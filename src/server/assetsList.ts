import { db } from './db'
import { INDEXES, BACKFILL, alterStatements } from '../../lib/asset-cols.mjs'
import { PIECE_SQL, describe } from '../../lib/asset-names.mjs'
import { offsetOf, likeEsc, paged, type PageQuery, type PageSpec, type Paged } from '~/lib/paging'

export type Tab = 'models' | 'textures' | 'animations' | 'sounds'
export type AssetRow = {
    id: number; pack: string; game: string; weaponId: string; display: string; group: string; piece: boolean; kind: string; source: string; score: number; pass: boolean; auditedAt: string
    hasModel: boolean; tris: number; verts: number; materials: number; fileHash: string
    texCount: number; texMax: number; texBytes: number; texMaps: string[]
    animCount: number; animLen: number; soundCount: number; soundLen: number; soundBytes: number
    flags: { code: string; severity: string; tab: Tab }[]
}
export type Agg = {
    total: number; audited: number
    bins: { lo: number; hi: number; label: string; count: number; tier: 'fail' | 'warn' | 'pass' }[]
    packs: { key: string; total: number; pass: number; rate: number }[]
    kinds: { key: string; total: number; pass: number; rate: number }[]
    flags: { code: string; severity: string; n: number; tab: Tab }[]
    worst: { weaponId: string; pack: string; kind: string; score: number }[]
    tabCounts: Record<Tab, number>
    games: string[]
}

/** Which tab a flag belongs to. */
export function flagTab(code: string): Tab {
    if (/TEX|NORMAL|ORM/.test(code) && !/^NO_MODEL/.test(code)) return 'textures'
    if (/CLIP|MAG|ANIM|ARMS|BOLT|CYCLE/.test(code)) return 'animations'
    if (/SOUND/.test(code)) return 'sounds'
    return 'models'
}

export const ASSET_SPEC: PageSpec = {
    sorts: ['asset', 'pack', 'game', 'tris', 'verts', 'mats', 'tex', 'texmax', 'texbytes', 'maps', 'clips', 'animlen', 'snd', 'sndlen', 'sndbytes', 'score'],
    sort: 'score', filters: ['tab', 'kind', 'pack', 'game', 'flag', 'min', 'max', 'pieces'],
}
const SORT_SQL: Record<string, string> = {
    asset: 'weaponId COLLATE NOCASE', pack: 'pack', game: 'game', tris: 'tris', verts: 'verts', mats: 'materials', tex: 'texCount', texmax: 'texMax',
    texbytes: 'texBytes', maps: 'texMaps', clips: 'animCount', animlen: 'animLen', snd: 'soundCount', sndlen: 'soundLen', sndbytes: 'soundBytes', score: 'score',
}
const n = (v: unknown) => Number(v ?? 0)
const asNames = (pack: string, id: string) => { const d = describe(pack, id); return { display: d.name, group: d.group, piece: d.piece } }

let ensured: Promise<void> | undefined
/** The denormalised columns, their indexes and the backfill of rows not yet shaped (idempotent; once per process). */
export function ensureAssetColumns() {
    return (ensured ??= (async () => {
        const have = new Set((await db.$queryRawUnsafe<{ name: string }[]>('PRAGMA table_info(AssetWeapon)')).map((c) => c.name))
        for (const s of alterStatements(have)) await db.$executeRawUnsafe(s)
        for (const s of INDEXES) await db.$executeRawUnsafe(s)
        await db.$executeRawUnsafe(BACKFILL)
    })().catch((e) => { ensured = undefined; throw e }))
}

/** Map pieces (props inside a map pack's model library or a map's own model folder) are hidden unless `pieces=1`. */
export const showPieces = (v: string | undefined) => v === '1'

function where(q: PageQuery) {
    const w: string[] = [], a: unknown[] = []
    const f = q.f
    if (f.kind) { w.push('kind = ?'); a.push(f.kind) }
    if (f.pack) { w.push('pack = ?'); a.push(f.pack) }
    if (f.game) { w.push("(',' || game || ',') LIKE ? ESCAPE '\\'"); a.push(`%,${likeEsc(f.game)},%`) }
    if (f.flag) { w.push("(' ' || flagCodes || ' ') LIKE ? ESCAPE '\\'"); a.push(`% ${likeEsc(f.flag)} %`) }
    if (f.min) { w.push('score >= ?'); a.push(Number(f.min) || 0) }
    if (f.max) { w.push('score <= ?'); a.push(Number(f.max) || 0) }
    if (!showPieces(q.f.pieces)) w.push(`NOT ${PIECE_SQL}`)
    if (q.q) { w.push("(weaponId LIKE ? ESCAPE '\\' OR pack LIKE ? ESCAPE '\\')"); a.push(`%${likeEsc(q.q)}%`, `%${likeEsc(q.q)}%`) }
    return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', a }
}

/** One page of the Assets table: filter, search, sort and limit all in SQL; only the visible rows are parsed. */
export async function assetPage(q: PageQuery): Promise<Paged<AssetRow>> {
    await ensureAssetColumns()
    const { sql, a } = where(q)
    const total = n((await db.$queryRawUnsafe<{ c: unknown }[]>(`SELECT COUNT(*) c FROM AssetWeapon ${sql}`, ...a))[0].c)
    const off = offsetOf(total, q)
    const col = SORT_SQL[q.sort] ?? 'score'
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
        `SELECT id, pack, game, weaponId, kind, source, score, pass, auditedAt, hasModel, tris, verts, materials, fileHash, texCount, texMax, texBytes, texMaps, animCount, animLen, soundCount, soundLen, soundBytes, json_extract(data,'$.flags') AS flags
         FROM AssetWeapon ${sql} ORDER BY ${col} ${q.dir === 'desc' ? 'DESC' : 'ASC'}, weaponId COLLATE NOCASE, id LIMIT ? OFFSET ?`, ...a, q.size, off)
    const out: AssetRow[] = rows.map((r) => {
        let fl: { code: string; severity: string }[] = []
        try { fl = r.flags ? JSON.parse(String(r.flags)) : [] } catch { /* ignore */ }
        return {
            id: n(r.id), pack: String(r.pack), game: String(r.game), weaponId: String(r.weaponId), ...asNames(String(r.pack), String(r.weaponId)), kind: String(r.kind), source: String(r.source), score: n(r.score), pass: n(r.pass) === 1, auditedAt: String(r.auditedAt),
            hasModel: n(r.hasModel) === 1, tris: n(r.tris), verts: n(r.verts), materials: n(r.materials), fileHash: String(r.fileHash),
            texCount: n(r.texCount), texMax: n(r.texMax), texBytes: n(r.texBytes), texMaps: String(r.texMaps).split(',').filter(Boolean),
            animCount: n(r.animCount), animLen: n(r.animLen), soundCount: n(r.soundCount), soundLen: n(r.soundLen), soundBytes: n(r.soundBytes),
            flags: fl.map((f) => ({ code: f.code, severity: f.severity, tab: flagTab(f.code) })),
        }
    })
    return paged(out, total, { page: q.page, size: q.size })
}

const group = (rows: { k: string; total: unknown; pass: unknown }[]) => rows.map((r) => ({ key: r.k, total: n(r.total), pass: n(r.pass), rate: n(r.pass) / Math.max(1, n(r.total)) }))
    .sort((a, b) => a.rate - b.rate || b.total - a.total || a.key.localeCompare(b.key))

/** Every chart number of the Assets page as SQL aggregates over the whole table (never the row set). */
export async function assetAgg(pieces = false): Promise<Agg> {
    await ensureAssetColumns()
    const W = pieces ? '' : `WHERE NOT ${PIECE_SQL}`, A = pieces ? '' : `AND NOT ${PIECE_SQL}`
    const [tot, bins, packs, kinds, flags, worst, games] = await Promise.all([
        db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT COUNT(*) total, SUM(source='audit') audited, SUM(hasModel) m, SUM(texCount>0) t, SUM(animCount>0) a, SUM(soundCount>0) s FROM AssetWeapon ${W}`),
        db.$queryRawUnsafe<{ b: unknown; c: unknown }[]>(`SELECT MIN(9, MAX(0, score / 10)) b, COUNT(*) c FROM AssetWeapon ${W} GROUP BY b`),
        db.$queryRawUnsafe<{ k: string; total: unknown; pass: unknown }[]>(`SELECT pack k, COUNT(*) total, SUM(pass) pass FROM AssetWeapon WHERE pack != '' ${A} GROUP BY pack`),
        db.$queryRawUnsafe<{ k: string; total: unknown; pass: unknown }[]>(`SELECT kind k, COUNT(*) total, SUM(pass) pass FROM AssetWeapon WHERE kind != '' ${A} GROUP BY kind`),
        db.$queryRawUnsafe<{ code: string; sev: string; c: unknown }[]>(`SELECT json_extract(f.value,'$.code') code, json_extract(f.value,'$.severity') sev, COUNT(*) c FROM AssetWeapon, json_each(AssetWeapon.data,'$.flags') f ${W} GROUP BY code, sev`),
        db.$queryRawUnsafe<{ weaponId: string; pack: string; kind: string; score: unknown }[]>(`SELECT weaponId, pack, kind, score FROM AssetWeapon ${W} ORDER BY score, weaponId LIMIT 8`),
        db.$queryRawUnsafe<{ game: string }[]>("SELECT DISTINCT game FROM AssetWeapon WHERE game != ''"),
    ])
    const t = tot[0]
    const bn = new Map(bins.map((r) => [n(r.b), n(r.c)]))
    return {
        total: n(t.total), audited: n(t.audited),
        bins: Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, hi: i === 9 ? 100 : i * 10 + 9, label: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}`, count: bn.get(i) ?? 0, tier: i >= 7 ? 'pass' as const : i >= 4 ? 'warn' as const : 'fail' as const })),
        packs: group(packs), kinds: group(kinds),
        flags: flags.map((f) => ({ code: f.code, severity: f.sev, n: n(f.c), tab: flagTab(f.code) })).sort((a, b) => b.n - a.n || a.code.localeCompare(b.code)),
        worst: worst.map((w) => ({ ...w, score: n(w.score) })),
        tabCounts: { models: n(t.m), textures: n(t.t), animations: n(t.a), sounds: n(t.s) },
        games: [...new Set(games.flatMap((g) => g.game.split(',').filter(Boolean)))].sort(),
    }
}
