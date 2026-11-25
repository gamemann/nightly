// ASSETS: attachments. An attachment (scope, suppressor, grip, ...) is its own AssetWeapon row (kind `attachment`); an AssetAttachment
// row links a parent asset (a weapon) to it with a mount slot and the transform the game places it at, in the parent model's space.
// The numbers come from the publisher (the pack's attachment export tool), which reads the game's own definitions.
//
// An audit document may carry, next to `assets[]`:
//   attach_links: [{ pack, parent: "<model key>" | "<weapon_id>", attachment: "<attachment weapon_id>", attachment_pack?, slot,
//                    pos: [x,y,z], rot?: [x,y,z] degrees, scale?: [x,y,z], node?, meta?: {} }]
// `parent` matches a weapon whose weapon_id equals it or ends with `__<it>` (the model key). Links are replaced per attachment on
// every ingest, so a removed compatibility disappears.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stats, readModel } from './glb.mjs'

const hasTable = (db, t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t)

/** Create the table when an install from before attachments ingests its first link (additive, idempotent). */
export function ensureTable(db) {
    if (hasTable(db, 'AssetAttachment')) return
    const f = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'prisma', 'migrations', '20261205000000_asset_attachments', 'migration.sql')
    const sql = readFileSync(f, 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n')
    for (const st of sql.split(/;\s*(?:\n|$)/).map((x) => x.trim()).filter(Boolean)) db.exec(st)
}

/** An attachment record needs only {pack, weapon_id, kind:'attachment', model:{glb}}: size numbers are read from the glb. */
export function prepareAttachment(rec, files) {
    rec.kind = 'attachment'
    rec.model ??= {}
    if (!files.glb) return
    try {
        const s = stats(readModel(files.glb))
        rec.model = { ...rec.model, tris: s.tris, verts: s.verts, materials: s.materials, meshes: s.meshes, bbox: s.bbox, bounds: s.bounds }
    } catch { /* an unreadable glb stays listed without numbers */ }
}

const num = (a, i, d) => (Array.isArray(a) && Number.isFinite(Number(a[i])) ? Number(a[i]) : d)

/** Store the links; returns {links, unresolved: [...]}. Existing links of each ingested attachment are replaced. */
export function linkAttachments(db, links) {
    ensureTable(db)
    const out = { links: 0, unresolved: [] }
    const att = (pack, id) => db.prepare('SELECT id FROM AssetWeapon WHERE pack = ? AND weaponId = ?').get(pack, id)
    const parents = (pack, key) => db.prepare("SELECT id FROM AssetWeapon WHERE pack = ? AND kind != 'attachment' AND (weaponId = ? OR weaponId LIKE ? ESCAPE '\\')").all(pack, key, `%\\_\\_${key.replace(/[\\%_]/g, '\\$&')}`)
    const ins = db.prepare('INSERT INTO AssetAttachment (parentId, attachmentId, slot, px, py, pz, rx, ry, rz, sx, sy, sz, node, meta, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    const now = new Date().toISOString(), cleared = new Set()
    db.exec('BEGIN')
    try {
        for (const l of links) {
            const a = att(l.attachment_pack ?? l.pack, l.attachment)
            if (!a) { out.unresolved.push(`${l.attachment}`); continue }
            if (!cleared.has(a.id)) { db.prepare('DELETE FROM AssetAttachment WHERE attachmentId = ?').run(a.id); cleared.add(a.id) }
            const ps = parents(l.pack, l.parent)
            if (!ps.length) { out.unresolved.push(`${l.parent}`); continue }
            for (const p of ps) {
                ins.run(p.id, a.id, l.slot, num(l.pos, 0, 0), num(l.pos, 1, 0), num(l.pos, 2, 0), num(l.rot, 0, 0), num(l.rot, 1, 0), num(l.rot, 2, 0), num(l.scale, 0, 1), num(l.scale, 1, 1), num(l.scale, 2, 1), l.node ?? '', JSON.stringify(l.meta ?? {}), now)
                out.links++
            }
        }
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    out.unresolved = [...new Set(out.unresolved)]
    return out
}

const row = (r) => ({ ...r, meta: JSON.parse(r.meta || '{}') })
/** Links of one asset: as a parent (its attachments) and as an attachment (the assets it fits). */
export function forAsset(db, id) {
    if (!hasTable(db, 'AssetAttachment')) return { attachments: [], fits: [] }
    const attachments = db.prepare('SELECT l.*, a.weaponId AS name, a.pack AS apack, a.tris AS atris FROM AssetAttachment l JOIN AssetWeapon a ON a.id = l.attachmentId WHERE l.parentId = ? ORDER BY l.slot, a.weaponId').all(id).map(row)
    const fits = db.prepare('SELECT l.*, p.weaponId AS name, p.pack AS apack FROM AssetAttachment l JOIN AssetWeapon p ON p.id = l.parentId WHERE l.attachmentId = ? ORDER BY p.weaponId, l.slot').all(id).map(row)
    return { attachments, fits }
}
