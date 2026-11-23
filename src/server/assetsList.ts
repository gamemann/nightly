import { db } from './db'
import { INDEXES, BACKFILL, alterStatements } from '../../lib/asset-cols.mjs'
import { PIECE_SQL, describe } from '../../lib/asset-names.mjs'
import { offsetOf, likeEsc, paged, type PageQuery, type PageSpec, type Paged } from '~/lib/paging'

export type Tab = 'models' | 'textures' | 'animations' | 'sounds' | 'maps'
export type AssetRow = {
    id: number; pack: string; game: string; weaponId: string; display: string; group: string; groupKey: string; piece: boolean; pieces: number; worst: number; kind: string; source: string; score: number; pass: boolean; auditedAt: string
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
    worst: { id: number; weaponId: string; pack: string; kind: string; score: number }[]
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
    sort: 'score', filters: ['tab', 'kind', 'pack', 'game', 'flag', 'min', 'max', 'pieces', 'grp'],
}
const SORT_SQL: Record<string, string> = {
    asset: 'weaponId COLLATE NOCASE', pack: 'pack', game: 'game', tris: 'tris', verts: 'verts', mats: 'materials', tex: 'texCount', texmax: 'texMax',
    texbytes: 'texBytes', maps: 'texMaps', clips: 'animCount', animlen: 'animLen', snd: 'soundCount', sndlen: 'soundLen', sndbytes: 'soundBytes', score: 'score',
}
const n = (v: unknown) => Number(v ?? 0)
const asNames = (pack: string, id: string) => { const d = describe(pack, id); return { display: d.name, group: d.group, groupKey: d.groupKey, piece: d.piece, pieces: 0, worst: 0 } }

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

/** Map pieces (props inside a map pack's model library or a map's own model folder) live on the Maps tab, one row per map or set; `pieces=1` lists the individual pieces (the link target of a map row). Every other tab is standalone assets only. */
export const showPieces = (v: string | undefined) => v === '1'

function where(q: PageQuery, only: 'rows' | 'pieces' = 'rows') {
    const w: string[] = [], a: unknown[] = []
    const f = q.f
    if (f.kind) { w.push('kind = ?'); a.push(f.kind) }
    if (f.pack) { w.push('pack = ?'); a.push(f.pack) }
    if (f.game) { w.push("(',' || game || ',') LIKE ? ESCAPE '\\'"); a.push(`%,${likeEsc(f.game)},%`) }
    if (f.flag) { w.push("(' ' || flagCodes || ' ') LIKE ? ESCAPE '\\'"); a.push(`% ${likeEsc(f.flag)} %`) }
    if (f.min) { w.push('score >= ?'); a.push(Number(f.min) || 0) }
    if (f.max) { w.push('score <= ?'); a.push(Number(f.max) || 0) }
    w.push(only === 'pieces' || showPieces(q.f.pieces) ? PIECE_SQL : `NOT ${PIECE_SQL}`)
    if (f.grp) { w.push("weaponId LIKE ? ESCAPE '\\'"); a.push(`%${likeEsc(`__${f.grp}__`)}%`) }
    if (q.q) { w.push("(weaponId LIKE ? ESCAPE '\\' OR pack LIKE ? ESCAPE '\\')"); a.push(`%${likeEsc(q.q)}%`, `%${likeEsc(q.q)}%`) }
    return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', a }
}

/** One page of the Assets table: filter, search, sort and limit all in SQL; only the visible rows are parsed. */
export async function assetPage(q: PageQuery): Promise<Paged<AssetRow>> {
    await ensureAssetColumns()
    if (q.f.tab === 'maps' && !showPieces(q.f.pieces)) return mapPage(q)
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
    return paged(uniqueNames(out), total, { page: q.page, size: q.size })
}

/** Two rows that read the same ("Character a" in four game packs) get their pack appended, so each is told apart. */
export function uniqueNames<T extends { display: string; pack: string }>(rows: T[]): T[] {
    const seen = new Map<string, number>()
    for (const r of rows) seen.set(r.display.toLowerCase(), (seen.get(r.display.toLowerCase()) ?? 0) + 1)
    return rows.map((r) => (seen.get(r.display.toLowerCase())! > 1 ? { ...r, display: `${r.display} · ${r.pack}` } : r))
}

type MapGroup = AssetRow
let mapCache: { at: number; rows: MapGroup[] } | undefined
/** One row per map (or library set) of every `*-maps` pack: pack + group from describe(). Piece count, summed tris and textures, worst and mean score, flag union. */
async function mapGroups(): Promise<MapGroup[]> {
    if (mapCache && Date.now() - mapCache.at < 15000) return mapCache.rows
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT pack, weaponId, kind, game, score, tris, verts, materials, hasModel, texCount, texBytes, flagCodes FROM AssetWeapon WHERE ${PIECE_SQL}`)
    const g = new Map<string, MapGroup & { sum: number; codes: Set<string>; games: Set<string> }>()
    for (const r of rows) {
        const pack = String(r.pack), d = describe(pack, String(r.weaponId)), key = `${pack}\u0000${d.groupKey}`
        let m = g.get(key)
        if (!m) {
            const label = d.group || 'model library'
            m = { id: -(g.size + 1), pack, game: '', weaponId: `${pack} / ${d.groupKey || 'model-library'}`, display: label[0].toUpperCase() + label.slice(1), group: '', groupKey: d.groupKey, piece: false, pieces: 0, worst: 100, kind: 'map', source: 'audit', score: 0, pass: false, auditedAt: '',
                hasModel: true, tris: 0, verts: 0, materials: 0, fileHash: '', texCount: 0, texMax: 0, texBytes: 0, texMaps: [], animCount: 0, animLen: 0, soundCount: 0, soundLen: 0, soundBytes: 0, flags: [], sum: 0, codes: new Set(), games: new Set() }
            g.set(key, m)
        }
        m.pieces++; m.sum += n(r.score); m.worst = Math.min(m.worst, n(r.score)); m.tris += n(r.tris); m.verts += n(r.verts); m.materials += n(r.materials); m.texCount += n(r.texCount); m.texBytes += n(r.texBytes)
        for (const c of String(r.flagCodes ?? '').split(' ').filter(Boolean)) m.codes.add(c)
        for (const x of String(r.game ?? '').split(',').filter(Boolean)) m.games.add(x)
    }
    const out = [...g.values()].map(({ sum, codes, games, ...m }) => ({ ...m, score: Math.round(sum / m.pieces), game: [...games].sort().join(','), pass: m.worst >= 70, flags: [...codes].sort().map((code) => ({ code, severity: 'warn', tab: flagTab(code) })) }))
    mapCache = { at: Date.now(), rows: out }
    return out
}
const MAP_SORT: Record<string, (r: MapGroup) => string | number> = {
    asset: (r) => r.display.toLowerCase(), pack: (r) => r.pack, game: (r) => r.game, tris: (r) => r.tris, verts: (r) => r.verts, mats: (r) => r.materials, tex: (r) => r.texCount, texbytes: (r) => r.texBytes, maps: (r) => r.pieces, score: (r) => r.score, worst: (r) => r.worst,
}
/** The Maps tab: the map rows, filtered, searched, sorted and paged in memory (a few hundred rows at most). */
async function mapPage(q: PageQuery): Promise<Paged<AssetRow>> {
    const f = q.f, needle = (q.q ?? '').toLowerCase()
    let rows = (await mapGroups()).filter((r) => (!f.pack || r.pack === f.pack) && (!f.game || r.game.split(',').includes(f.game)) && (!f.flag || r.flags.some((x) => x.code === f.flag)) && (!f.min || r.score >= Number(f.min)) && (!f.max || r.score <= Number(f.max)) && (!needle || r.display.toLowerCase().includes(needle) || r.pack.toLowerCase().includes(needle)))
    const key = MAP_SORT[q.sort] ?? MAP_SORT.score, sgn = q.dir === 'desc' ? -1 : 1
    rows = rows.sort((a, b) => { const x = key(a), y = key(b); return (x < y ? -1 : x > y ? 1 : 0) * sgn || a.display.localeCompare(b.display) || a.pack.localeCompare(b.pack) })
    const off = offsetOf(rows.length, q)
    return paged(uniqueNames(rows.slice(off, off + q.size)), rows.length, { page: q.page, size: q.size })
}

const group = (rows: { k: string; total: unknown; pass: unknown }[]) => rows.map((r) => ({ key: r.k, total: n(r.total), pass: n(r.pass), rate: n(r.pass) / Math.max(1, n(r.total)) }))
    .sort((a, b) => a.rate - b.rate || b.total - a.total || a.key.localeCompare(b.key))

/** Every chart number of the Assets page as SQL aggregates over the whole table (never the row set). */
export async function assetAgg(): Promise<Agg> {
    await ensureAssetColumns()
    const W = `WHERE NOT ${PIECE_SQL}`, A = `AND NOT ${PIECE_SQL}`
    const [tot, bins, packs, kinds, flags, worst, games] = await Promise.all([
        db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT COUNT(*) total, SUM(source='audit') audited, SUM(hasModel) m, SUM(texCount>0) t, SUM(animCount>0) a, SUM(soundCount>0) s FROM AssetWeapon ${W}`),
        db.$queryRawUnsafe<{ b: unknown; c: unknown }[]>(`SELECT MIN(9, MAX(0, score / 10)) b, COUNT(*) c FROM AssetWeapon ${W} GROUP BY b`),
        db.$queryRawUnsafe<{ k: string; total: unknown; pass: unknown }[]>(`SELECT pack k, COUNT(*) total, SUM(pass) pass FROM AssetWeapon WHERE pack != '' ${A} GROUP BY pack`),
        db.$queryRawUnsafe<{ k: string; total: unknown; pass: unknown }[]>(`SELECT kind k, COUNT(*) total, SUM(pass) pass FROM AssetWeapon WHERE kind != '' ${A} GROUP BY kind`),
        db.$queryRawUnsafe<{ code: string; sev: string; c: unknown }[]>(`SELECT json_extract(f.value,'$.code') code, json_extract(f.value,'$.severity') sev, COUNT(*) c FROM AssetWeapon, json_each(AssetWeapon.data,'$.flags') f ${W} GROUP BY code, sev`),
        db.$queryRawUnsafe<{ id: unknown; weaponId: string; pack: string; kind: string; score: unknown }[]>(`SELECT id, weaponId, pack, kind, score FROM AssetWeapon ${W} ORDER BY score, weaponId LIMIT 8`),
        db.$queryRawUnsafe<{ game: string }[]>("SELECT DISTINCT game FROM AssetWeapon WHERE game != ''"),
    ])
    const t = tot[0], maps = await mapGroups()
    const bn = new Map(bins.map((r) => [n(r.b), n(r.c)]))
    return {
        total: n(t.total), audited: n(t.audited),
        bins: Array.from({ length: 10 }, (_, i) => ({ lo: i * 10, hi: i === 9 ? 100 : i * 10 + 9, label: `${i * 10}-${i === 9 ? 100 : i * 10 + 9}`, count: bn.get(i) ?? 0, tier: i >= 7 ? 'pass' as const : i >= 4 ? 'warn' as const : 'fail' as const })),
        packs: group(packs), kinds: group(kinds),
        flags: flags.map((f) => ({ code: f.code, severity: f.sev, n: n(f.c), tab: flagTab(f.code) })).sort((a, b) => b.n - a.n || a.code.localeCompare(b.code)),
        worst: worst.map((w) => ({ ...w, id: n(w.id), score: n(w.score) })),
        tabCounts: { models: n(t.m), textures: n(t.t), animations: n(t.a), sounds: n(t.s), maps: maps.length },
        games: [...new Set(games.flatMap((g) => g.game.split(',').filter(Boolean)))].sort(),
    }
}
