// ASSETS: weapon definitions and game sound events, both read from a source's own files as its config says (lib/assets-sources.mjs).
// A game's gun sounds can be events, not files: its audio script maps a weapon-use kind (shot, swing, ...) to an event id, and the
// weapon packs the game links resolve through it, so the asset page lists the event a gun plays.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { globToRe } from './assets-sources.mjs'

export const DEFAULT_ID_RE = '\\[resource\\][\\s\\S]*?\\nid = &?"([^"]+)"'
export const DEFAULT_BEHAVIOUR_RE = '\\nbehaviour_path = "[^"]*?([^/"]+)\\.gd"'
export const DEFAULT_BEHAVIOUR_KINDS = [['beam', 'beam'], ['melee|shield', 'swing'], ['projectile', 'spawn'], ['thrown', 'throw']]

export const normId = (id) => id.toLowerCase().replace(/[-\s]/g, '_')
/** Does sound `stem` belong to asset `wid`? (stem starts with the id, or the id starts with the stem's first token) */
export function soundMatches(stem, wid, dirName = '') {
    const s = normId(stem), w = normId(wid)
    if (dirName && dirName.toLowerCase() === w) return true
    if (s.startsWith(w + '_') || s === w) return true
    const tok = s.split('_')[0]
    return tok.length >= 3 && (w === tok || w.startsWith(tok + '_'))
}

/** Assets declared by a source's definition files (config.weaponDefs): [{id, behaviour}]. */
export function defInfo(root, spec) {
    if (!spec?.glob) return []
    const re = globToRe(spec.glob), dir = path.dirname(spec.glob).replace(/\*.*/, '') || '.'
    const base = path.join(root, dir)
    if (!existsSync(base)) return []
    const idRe = new RegExp(spec.idRegex || DEFAULT_ID_RE), bRe = new RegExp(spec.behaviourRegex || DEFAULT_BEHAVIOUR_RE)
    const out = []
    for (const f of readdirSync(base)) {
        const rel = dir === '.' ? f : `${dir}/${f}`
        if (!re.test(rel)) continue
        let txt
        try { txt = readFileSync(path.join(root, rel), 'utf8') } catch { continue }
        const m = idRe.exec(txt)
        if (m) out.push({ id: m[1], behaviour: bRe.exec(txt)?.[1] ?? '' })
    }
    return out
}

export const kindOfBehaviour = (b, table = DEFAULT_BEHAVIOUR_KINDS) => table.find(([re]) => new RegExp(re).test(b))?.[1] ?? 'shot'

/** Parse a game's audio table: { kind -> { event, voice, file, maxDistance, concurrent } }. Pure on the source text. */
export function parseEventTable(src) {
    const ids = {}
    for (const m of src.matchAll(/^const (\w+) := &"(\w+)"/gm)) ids[m[1]] = m[2]
    const voices = {}
    for (const m of src.matchAll(/^\s*(\w+): \w+\.Voice\.(\w+),/gm)) voices[m[1]] = m[2]
    const placed = {}
    for (const m of src.matchAll(/_placed\((\w+),\s*([\d.]+),\s*[\d.]+,\s*(\d+),[^)]*?"([^"]*)"\)/g)) placed[m[1]] = { maxDistance: +m[2], concurrent: +m[3], file: m[4] }
    const table = {}
    const fn = /static func weapon_sound\([^)]*\)[^:]*:\n([\s\S]*?)(?:\n\S|$)/.exec(src)?.[1] ?? ''
    for (const m of fn.matchAll(/KIND_(\w+):\s*\n\s*return (\w+)/g)) {
        const c = m[2]
        if (!ids[c]) continue
        table[m[1].toLowerCase()] = { event: ids[c], voice: voices[c] ?? '', file: placed[c]?.file ?? '', maxDistance: placed[c]?.maxDistance ?? 0, concurrent: placed[c]?.concurrent ?? 0 }
    }
    return table
}

/** The event tables of the sources that declare one: [{ game, file, table, behaviourKinds, defs: Map(sourceName -> Map(id -> behaviour)) }]. */
export function eventGames(sources) {
    const byName = new Map(sources.map((s) => [s.name, s]))
    const out = []
    for (const s of sources) {
        const et = s.config.eventTable
        if (!et?.file || !s.root) continue
        let table = {}
        try { table = parseEventTable(readFileSync(path.join(s.root, et.file), 'utf8')) } catch { /* not checked out */ }
        const defs = new Map()
        for (const n of et.linkedSources ?? []) { const l = byName.get(n); if (l) defs.set(n, new Map(defInfo(l.root, l.config.weaponDefs).map((d) => [d.id, d.behaviour]))) }
        out.push({ game: s.name, file: et.file, table, behaviourKinds: et.behaviourKinds ?? DEFAULT_BEHAVIOUR_KINDS, defs })
    }
    return out
}
/** Sound entries for the events the games' tables resolve for this asset record. */
export function eventSounds(rec, games) {
    const out = []
    for (const g of games) {
        const defs = g.defs.get(rec.pack)
        const id = [rec.weapon_id, rec.def_id].find((i) => i && defs?.has(i))
        if (!id) continue
        const kind = kindOfBehaviour(defs.get(id), g.behaviourKinds)
        const ev = g.table[kind]
        if (!ev) continue
        out.push({ name: ev.event, event: ev.event, game: g.game, kind, synth: ev.file ? '' : ev.voice, file: ev.file, max_distance: ev.maxDistance, concurrent: ev.concurrent, source: `${g.game}/${g.file}`, len: 0, rate: 0, bytes: 0 })
    }
    return out
}
export function withEvents(rec, files, games) {
    for (const s of eventSounds(rec, games)) { if (rec.sounds.some((x) => x.event === s.event && x.game === s.game)) continue; rec.sounds.push(s); files.sounds.push({ kind: 'event' }) }
}
