import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { db } from "./db"

export type MapRow = { id: number; name: string; pack: string; score: number; pass: boolean; tris: number; surfaces: number; spawns: number; hulls: number; untextured: number; hasOriginal: boolean; flags: string[]; title?: string; gameMap?: boolean }

/** Every converted map (kind `level`), one row per pack that ships it. */
export async function mapRows(): Promise<MapRow[]> {
    const rows = await db.assetWeapon.findMany({ where: { kind: "level" }, select: { id: true, pack: true, weaponId: true, score: true, pass: true, tris: true, flagCodes: true, data: true }, orderBy: [{ weaponId: "asc" }, { pack: "asc" }] })
    const out = rows.map((r) => {
        const m = (JSON.parse(r.data) as { map?: { surfaces?: number; spawns?: number; hulls?: number; untextured?: number; original?: { error?: string; source?: string } } }).map ?? {}
        return { id: r.id, name: r.weaponId, pack: r.pack, score: r.score, pass: r.pass === 1, tris: r.tris, surfaces: m.surfaces ?? 0, spawns: m.spawns ?? 0, hulls: m.hulls ?? 0, untextured: m.untextured ?? 0, hasOriginal: !!m.original && !m.original.error, flags: String(r.flagCodes ?? "").split(" ").filter(Boolean) }
    })
    return [...out, ...(await definitionOnly(new Set(out.map((r) => `${r.pack}/${r.name}`))))].sort((a, b) => a.name.localeCompare(b.name) || a.pack.localeCompare(b.pack))
}

/** Maps a pack lists in manifests (the source's `maps` globs) that have no converted geometry to view (a game's map definition: spawns, rules, environment). Shown on the Maps page without a viewer. */
async function definitionOnly(have: Set<string>): Promise<MapRow[]> {
    const out: MapRow[] = []
    for (const s of await db.assetSource.findMany({ select: { name: true, root: true, config: true } })) {
        let globs: string[] = []
        try { globs = (JSON.parse(s.config) as { maps?: string[] }).maps ?? [] } catch { /* no config */ }
        for (const g of globs) {
            const parts = g.split("/"), files: string[] = []
            const walk = (dir: string, i: number) => {
                if (i === parts.length - 1) { for (const f of safeDir(dir)) if (f.isFile() && f.name.endsWith(".json")) files.push(path.join(dir, f.name)); return }
                for (const f of safeDir(dir)) if (f.isDirectory() && (parts[i] === "*" || f.name === parts[i])) walk(path.join(dir, f.name), i + 1)
            }
            if (existsSync(s.root)) walk(s.root, 0)
            for (const f of files) {
                const stem = path.basename(f, ".json")
                if (have.has(`${s.name}/${stem}`) || out.some((o) => o.pack === s.name && o.name === stem)) continue
                try {
                    const j = JSON.parse(readFileSync(f, "utf8")) as { name?: string; id?: string; kind?: string }
                    if (!j.id && !j.name) continue
                    out.push({ id: 0, name: stem, title: j.name, pack: s.name, score: 0, pass: false, tris: 0, surfaces: 0, spawns: 0, hulls: 0, untextured: 0, hasOriginal: false, flags: [], gameMap: true })
                } catch { /* not a manifest */ }
            }
        }
    }
    return out
}
const safeDir = (d: string) => { try { return readdirSync(d, { withFileTypes: true }) } catch { return [] } }
