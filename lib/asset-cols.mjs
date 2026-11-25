// Denormalised AssetWeapon columns for the Assets table: the page sorts, filters, counts and charts in SQL, so every number a
// column shows lives in a real column instead of inside the audit JSON. Shared by the CLI (node:sqlite) and the panel (Prisma
// raw); both run the same statements. `shape` is 0 until a row is backfilled, so the backfill is idempotent and resumable.
export const COLS = [
    ['hasModel', 'INTEGER NOT NULL DEFAULT 0'], ['verts', 'INTEGER NOT NULL DEFAULT 0'], ['materials', 'INTEGER NOT NULL DEFAULT 0'],
    ['texMax', 'INTEGER NOT NULL DEFAULT 0'], ['texBytes', 'INTEGER NOT NULL DEFAULT 0'], ['texMaps', "TEXT NOT NULL DEFAULT ''"],
    ['animLen', 'REAL NOT NULL DEFAULT 0'], ['soundLen', 'REAL NOT NULL DEFAULT 0'], ['soundBytes', 'INTEGER NOT NULL DEFAULT 0'],
    ['fileHash', "TEXT NOT NULL DEFAULT ''"], ['shape', 'INTEGER NOT NULL DEFAULT 0'],
    ['coverage', "TEXT NOT NULL DEFAULT ''"],   // asset-coverage.mjs: JSON {s: status per dimension, o: orphan reason, g: gaps}
]
export const INDEXES = [
    'CREATE INDEX IF NOT EXISTS "AssetWeapon_pack_idx" ON "AssetWeapon"("pack")',
    'CREATE INDEX IF NOT EXISTS "AssetWeapon_score_idx" ON "AssetWeapon"("score")',
    'CREATE INDEX IF NOT EXISTS "AssetWeapon_tris_idx" ON "AssetWeapon"("tris")',
    'CREATE INDEX IF NOT EXISTS "AssetWeapon_kind_pack_idx" ON "AssetWeapon"("kind", "pack")',
]
/** ALTER statements for the columns not in `existing` (a Set of column names). */
export const alterStatements = (existing) => COLS.filter(([n]) => !existing.has(n)).map(([n, t]) => `ALTER TABLE "AssetWeapon" ADD COLUMN "${n}" ${t}`)
export const BACKFILL = `UPDATE AssetWeapon SET
  hasModel = CASE WHEN COALESCE(json_extract(data,'$._files.glb'),'') != '' THEN 1 ELSE 0 END,
  verts = COALESCE(json_extract(data,'$.model.verts'),0),
  materials = COALESCE(json_extract(data,'$.model.materials'),0),
  texMax = COALESCE((SELECT MAX(MAX(COALESCE(json_extract(t.value,'$.w'),0), COALESCE(json_extract(t.value,'$.h'),0))) FROM json_each(AssetWeapon.data,'$.textures') t),0),
  texBytes = COALESCE((SELECT SUM(COALESCE(json_extract(t.value,'$.bytes'),0)) FROM json_each(AssetWeapon.data,'$.textures') t),0),
  texMaps = COALESCE((SELECT group_concat(DISTINCT m.value) FROM json_each(AssetWeapon.data,'$.textures') t, json_each(t.value,'$.maps') m),''),
  animLen = COALESCE((SELECT SUM(COALESCE(json_extract(a.value,'$.length'),0)) FROM json_each(AssetWeapon.data,'$.animations') a),0),
  soundLen = COALESCE((SELECT SUM(COALESCE(json_extract(s.value,'$.len'),0)) FROM json_each(AssetWeapon.data,'$.sounds') s),0),
  soundBytes = COALESCE((SELECT SUM(COALESCE(json_extract(s.value,'$.bytes'),0)) FROM json_each(AssetWeapon.data,'$.sounds') s),0),
  shape = 1
WHERE shape = 0`

/** The same numbers computed in JS from an audit record, for upsert (so a fresh row is born with shape = 1). */
export function shapeOf(rec, files) {
    const tex = rec.textures ?? [], anim = rec.animations ?? [], snd = rec.sounds ?? []
    return {
        hasModel: files?.glb ? 1 : 0, verts: rec.model?.verts ?? 0, materials: rec.model?.materials ?? 0,
        texMax: Math.max(0, ...tex.map((t) => Math.max(t.w ?? 0, t.h ?? 0))), texBytes: tex.reduce((n, t) => n + (t.bytes ?? 0), 0),
        texMaps: [...new Set(tex.flatMap((t) => t.maps ?? []))].join(','),
        animLen: anim.reduce((n, a) => n + (a.length ?? 0), 0), soundLen: snd.reduce((n, s) => n + (s.len ?? 0), 0), soundBytes: snd.reduce((n, s) => n + (s.bytes ?? 0), 0),
    }
}
/** Add the missing columns and indexes and backfill unshaped rows with node:sqlite. Returns how many rows were backfilled. */
export function ensureColumns(db) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='AssetWeapon'").get()) return 0
    const have = new Set(db.prepare('PRAGMA table_info(AssetWeapon)').all().map((c) => c.name))
    for (const s of alterStatements(have)) db.exec(s)
    for (const s of INDEXES) db.exec(s)
    return Number(db.prepare(BACKFILL).run().changes)
}
