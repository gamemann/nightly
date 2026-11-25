// ASSETS: sources, the places assets live. One AssetSource row per pack or game checkout; `config` is JSON (all keys optional):
//   models / textures / sounds   path globs relative to the root ("**" = any depth, "*" = within one directory)
//   maps                         path globs of converted-map manifests (default none); each is exported to a GLB for the fly-cam viewer
//                                and listed as kind mapKind (default "map"); mapChunk = culling cell edge in metres (default 32, 0 = none)
//   mapCompanions                templates ({stem}, {dir}; relative to the tier manifest's folder) for the mesh manifest that carries the
//                                material mapping and the props (default ["worlds/{stem}/{stem}.json", "worlds/{stem}.json"], nested then flat)
//   mapPbrRoots / mapModelRoots  extra directories (absolute, or relative to the source root) searched for PBR texture sets / prop models
//   mapOriginalRoots / mapOriginalMatch / mapOriginalConverter / mapOriginalTimeoutSec (and mapOriginalPythonModules, probed before converting): where the source (original) BSP of each map lives and the
//                                command that converts it, so the viewer can show original, converted or both (see map-originals.mjs)
//   mapTexMax (1024) / mapTexFormat (webp|jpg|png) / mapTexBudgetMb (256) / mapTexScale (0.5 repeats per metre): embedded texture size,
//                                encoding, GPU-memory budget (the size halves until it fits) and world-triplanar tiling
//   exclude                      directory names never entered (default: .git .godot .import node_modules)
//   defaultKind, kindRules       [{match: regex on the relative path, kind}] checked before the kinds' own regexes
//   soundKinds                   kinds that get sounds attached (default: the kinds marked `sounds` in AssetKind); soundMatch: id-prefix | all | none
//   weaponDefs                   {glob, idRegex, behaviourRegex}: definition files that list the weapons of a pack (one entry each)
//   eventTable                   {file, linkedSources: [names], behaviourKinds: [[regex, kind]]}: a game's source file mapping a
//                                weapon-use kind to a sound event, resolved for the weapons of the linked sources
//                                fallback {event, file}: a weapon of this source no table entry covers plays that shared class, by use kind (guessed from its id).
//                                A game's own row of a linked pack's weapon inherits the pack definition's sound. `file` may then be omitted.
//   icons                        path globs of HUD/inventory icons; an icon covers the asset whose model stem or id tail has its stem
//   licenceRules, licenceFile    [{match: regex on the model path, licence}] checked first, then licenceFile (default licence.json:
//                                [{paths: [prefix], licence}], longest prefix wins); see asset-coverage.mjs
//   compare                      false to skip the game-local-copy comparison against pack entries (default true)
// No source is built in: add yours in the panel (/assets/sources) or `nightly assets source add`.
import { existsSync } from 'node:fs'
import path from 'node:path'
import * as K from './assets-kinds.mjs'

const nowIso = () => new Date().toISOString()
export const SOURCE_TYPES = ['pack', 'game']
export const DEFAULTS = {
    models: ['**/*.glb', '**/*.gltf'],
    textures: ['**/*.png', '**/*.jpg', '**/*.jpeg', '**/*.webp'],
    sounds: ['**/*.ogg', '**/*.wav', '**/*.mp3'],
    exclude: ['.git', '.godot', '.import', 'node_modules'],
    soundMatch: 'id-prefix',
    mapCompanions: ['worlds/{stem}/{stem}.json', 'worlds/{stem}.json'],   // a world folder per map, or one flat worlds/ folder
}
const LISTS = ['models', 'maps', 'mapCompanions', 'mapPbrRoots', 'mapModelRoots', 'mapOriginalRoots', 'mapOriginalMatch', 'mapOriginalConverter', 'mapOriginalPythonModules', 'textures', 'sounds', 'exclude', 'soundKinds', 'icons']

export function globToRe(g) {
    let s = ''
    for (let i = 0; i < g.length; i++) {
        const c = g[i]
        if (c === '*' && g[i + 1] === '*') { s += g[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += g[i + 2] === '/' ? 2 : 1 }
        else if (c === '*') s += '[^/]*'
        else if (c === '?') s += '[^/]'
        else s += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(`^${s}$`, 'i')
}
/** The effective config: defaults under the stored keys. */
// `rsi-assets` is the audit's own output folder (<cwd>/data/rsi-assets, its glb/ copies of every model): when the tool runs from inside a
// pack checkout that folder sits under the source root, and scanning it re-ingests the whole library as the pack's models. Never entered.
export const ALWAYS_EXCLUDE = ['rsi-assets', 'wt-*']
/** A source config with the defaults filled in; `kinds` (AssetKind rows) give the default soundKinds. */
export const effective = (cfg, kinds = []) => { const e = { ...DEFAULTS, ...cfg }; e.soundKinds ??= K.soundKinds(kinds); e.exclude = [...new Set([...(e.exclude ?? []), ...ALWAYS_EXCLUDE])]; return e }

export function validateConfig(cfg) {
    if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) throw new Error('source config must be a JSON object')
    for (const k of LISTS) if (cfg[k] != null && !(Array.isArray(cfg[k]) && cfg[k].every((x) => typeof x === 'string'))) throw new Error(`config.${k} must be a list of strings`)
    if (cfg.mapOriginalConverter?.length && !cfg.mapOriginalConverter.some((a) => a.includes('{input}')) ) throw new Error('config.mapOriginalConverter needs an {input} placeholder')
    if (cfg.mapOriginalTimeoutSec != null && !(Number(cfg.mapOriginalTimeoutSec) > 0)) throw new Error('config.mapOriginalTimeoutSec must be a number > 0')
    if (cfg.mapKind != null && typeof cfg.mapKind !== 'string') throw new Error('config.mapKind must be a kind key')
    if (cfg.mapChunk != null && !(Number(cfg.mapChunk) >= 0)) throw new Error('config.mapChunk must be a number of metres >= 0')
    for (const k of ['mapTexMax', 'mapTexBudgetMb', 'mapTexScale']) if (cfg[k] != null && !(Number(cfg[k]) > 0)) throw new Error(`config.${k} must be a number > 0`)
    if (cfg.mapTexFormat != null && !['webp', 'jpg', 'png'].includes(cfg.mapTexFormat)) throw new Error('config.mapTexFormat: webp | jpg | png')
    for (const r of cfg.kindRules ?? []) { try { new RegExp(r.match, 'i') } catch (e) { throw new Error(`kindRules: bad regex ${r.match}: ${e.message}`) } if (!r.kind) throw new Error('kindRules: each rule needs a kind') }
    for (const r of cfg.licenceRules ?? []) { try { new RegExp(r.match, 'i') } catch (e) { throw new Error(`licenceRules: bad regex ${r.match}: ${e.message}`) } if (!r.licence) throw new Error('licenceRules: each rule needs a licence') }
    if (cfg.licenceFile != null && typeof cfg.licenceFile !== 'string') throw new Error('config.licenceFile must be a path relative to the root')
    if (cfg.soundMatch != null && !['id-prefix', 'all', 'none'].includes(cfg.soundMatch)) throw new Error('config.soundMatch: id-prefix | all | none')
    for (const re of [cfg.weaponDefs?.idRegex, cfg.weaponDefs?.behaviourRegex]) if (re) { try { new RegExp(re) } catch (e) { throw new Error(`weaponDefs: bad regex: ${e.message}`) } }
    for (const [re] of cfg.eventTable?.behaviourKinds ?? []) { try { new RegExp(re) } catch (e) { throw new Error(`eventTable.behaviourKinds: bad regex ${re}`) } }
    return cfg
}
const parseRow = (r) => ({ ...r, enabled: !!r.enabled, config: JSON.parse(r.config || '{}') })
export const list = (db) => db.prepare('SELECT * FROM AssetSource ORDER BY type, name').all().map(parseRow)
export function get(db, name) {
    const r = db.prepare('SELECT * FROM AssetSource WHERE name = ?').get(name)
    if (!r) throw new Error(`no such source: ${name} (nightly assets source list)`)
    return parseRow(r)
}
export function add(db, s) {
    if (!/^[A-Za-z0-9][\w.-]*$/.test(s.name ?? '')) throw new Error('source name: letters, digits, . _ - (it is the "pack" column of every asset)')
    const type = s.type ?? 'pack'
    if (!SOURCE_TYPES.includes(type)) throw new Error(`source type: ${SOURCE_TYPES.join(' | ')}`)
    if (!s.root && !s.repo) throw new Error('a source needs a root directory (or a repo)')
    const cfg = validateConfig(s.config ?? {})
    const t = nowIso()
    db.prepare('INSERT INTO AssetSource (name, type, root, repo, enabled, config, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?)').run(s.name, type, s.root ?? '', s.repo ?? '', s.enabled === false ? 0 : 1, JSON.stringify(cfg), t, t)
    return get(db, s.name)
}
/** Patch a source: scalar fields replace, `config` keys merge (a key set to null is removed). */
export function set(db, name, patch) {
    const cur = get(db, name)
    const cfg = { ...cur.config }
    for (const [k, v] of Object.entries(patch.config ?? {})) { if (v === null) delete cfg[k]; else cfg[k] = v }
    validateConfig(cfg)
    const type = patch.type ?? cur.type
    if (!SOURCE_TYPES.includes(type)) throw new Error(`source type: ${SOURCE_TYPES.join(' | ')}`)
    db.prepare('UPDATE AssetSource SET type=?, root=?, repo=?, enabled=?, config=?, updatedAt=? WHERE name=?')
        .run(type, patch.root ?? cur.root, patch.repo ?? cur.repo, (patch.enabled ?? cur.enabled) ? 1 : 0, JSON.stringify(cfg), nowIso(), name)
    return get(db, name)
}
/** Delete a source; with purge also its asset rows (otherwise they stay, listed under the old name). */
export function remove(db, name, { purge = false } = {}) {
    get(db, name)
    let rows = 0
    if (purge) rows = db.prepare('DELETE FROM AssetWeapon WHERE pack = ?').run(name).changes
    db.prepare('DELETE FROM AssetSource WHERE name = ?').run(name)
    return { rows }
}
export const touch = (db, name) => db.prepare('UPDATE AssetSource SET lastScanAt = ? WHERE name = ?').run(nowIso(), name)
export const rootOf = (s) => path.resolve(s.root)
export const rootExists = (s) => !!s.root && existsSync(s.root)
export const serveRoots = (db) => list(db).filter((s) => s.root).map((s) => path.resolve(s.root))

/** Everything the audit tool needs, as JSON (schema rsi-config/1): the enabled sources, the kinds with budgets, the tiers. */
export function exportConfig(db, { tiers = ['low', 'medium', 'high'] } = {}) {
    const kinds = K.list(db)
    return {
        schema: 'rsi-config/1',
        tiers,
        sources: list(db).filter((s) => s.enabled && rootExists(s)).map((s) => ({ name: s.name, type: s.type, root: rootOf(s), ...effective(s.config, kinds) })),
        kinds: kinds.map((k) => ({ key: k.key, label: k.label, sort: k.sort, match: k.match, budget: k.budget, tab: k.tab, sounds: k.sounds })),
    }
}
