// Naming rules: everything that is specific to one workspace's repo names (old-name -> current-slug renames, which
// keywords mean which game, which repo prefixes are addons or backbone). It is DATA: the `namingRules` Setting row (JSON),
// edited with `nightly set namingRules '<json>'`. Nothing here names a game or repo; with no row the resolver and
// classifier only know the generic rules (slug match, `game-`/`mg-` prefixes, trailing-counter stripping).
//
// Dependency-free so the panel can import it. State is module-level: call `setRules(obj)` once per process (CLI: `loadRules(db)`
// with a node:sqlite handle; panel: `loadRulesAsync(read)` with a function returning the setting text).
//
// Shape (all keys optional):
//   renames          { "old-repo-name": "current-slug" }            old names/aliases of projects (also per project: settings.aliases)
//   rewrites         [[regex, replacement]]                         applied in order to a token to find a renamed family (dot-core -> gs-core)
//   packGames        [[regex, game-slug]]                           packs that belong to a game without `<game>-maps` naming
//   general          [tag]                                          extra tags that name an area, not a repo (item stays unlinked)
//   games            [slug]                                         game slugs the classifier knows beyond the keyword targets
//   gameKeywords     [[regex, slug]]                                key/title keywords -> game (first match wins)
//   gameAliases      { "repo-name": "slug" }                        repo names that file under a game/area slug
//   backbone, dev    regex source                                   repo-name prefixes that file under "backbone" / "dev"
//   repoTokens       [regex source]                                 extra repo-name shapes recognised in item titles
//   lateAliases      { "repo-name": "slug" }                        like gameAliases, but only after the `<x>-maps` rule (the repo is a weak hint)
//   skipRepo         regex source                                   repos never seeded as projects (default: dot dirs, -wt, -bak)
//   webRepo          regex source                                   repo names that are websites (default ^website-)
//   twins            [[regex, replacement]]                         an old repo is skipped when its replacement exists (dot-x -> gs-x)
//   repoClasses      [[regex, type, "Folder/Sub"]]                  first match classifies a repo (type: website|game|game-addon)
//   backboneText, devText  regex source (case-insensitive)          title words of untagged items filed under backbone / dev
//   backboneKey, devKey    regex source                             key prefixes of untagged items filed under backbone / dev
export const GENERAL_DEFAULT = ['dev', 'backbone', 'all', 'games', 'game-*', 'mg-*', 'website', 'godot', 'external', 'other', 'repos', 'docs', 'scripts', 'stack', 'store']
const REPO_TOKEN_BASE = '(?:game|mg)-[a-z0-9]+(?:-[a-z0-9]+){0,3}'

const empty = () => ({ renames: {}, rewrites: [], packGames: [], general: [], games: [], gameKeywords: [], gameAliases: {}, lateAliases: {}, skipRepo: null, webRepo: null, twins: [], repoClasses: null, backbone: null, dev: null, repoTokens: [], backboneText: null, devText: null, backboneKey: null, devKey: null })
export const rules = empty()
export const REPO_CLASSES_DEFAULT = [['-maps$', 'game-addon', 'Game Addons/Map packs'], ['-weapons$', 'game-addon', 'Game Addons/Weapon packs'], ['^mg-', 'game', 'Games/Minigames'], ['^game-', 'game', 'Games']]
export const compiled = { skipRepo: /^\.|-wt(-|$)|-bak$/, webRepo: /^website-/, twins: [], repoClasses: [], gameKeywords: [], backbone: null, dev: null, backboneText: null, devText: null, backboneKey: null, devKey: null, repoToken: null, general: new Set(GENERAL_DEFAULT) }
const rx = (s, flags = '') => (s ? new RegExp(s, flags) : null)

/** Check rules text without applying it; returns the error message or ''. */
export function validateRules(input) {
    const keep = JSON.stringify(rules), keepC = { ...compiled }
    try { setRules(input); return '' } catch (e) { return e.message } finally { Object.assign(rules, JSON.parse(keep)); Object.assign(compiled, keepC) }
}

/** Replace the rules (a JSON object or its text). Bad input throws and leaves the old rules in place. */
export function setRules(input) {
    let o = input
    if (typeof o === 'string') o = o.trim() ? JSON.parse(o) : {}
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('namingRules must be a JSON object')
    const next = { ...empty(), ...o }
    const c = {
        skipRepo: new RegExp(next.skipRepo || '^\\.|-wt(-|$)|-bak$'), webRepo: new RegExp(next.webRepo || '^website-'),
        twins: (next.twins ?? []).map(([re, to]) => [new RegExp(re), to]),
        repoClasses: (next.repoClasses ?? REPO_CLASSES_DEFAULT).map(([re, type, folder]) => [new RegExp(re), type, String(folder).split('/')]),
        gameKeywords: (next.gameKeywords ?? []).map(([re, g]) => [new RegExp(re), g]),
        backbone: rx(next.backbone), dev: rx(next.dev), backboneText: rx(next.backboneText, 'i'), devText: rx(next.devText, 'i'),
        backboneKey: rx(next.backboneKey), devKey: rx(next.devKey),
        repoToken: new RegExp(`\\b(${[REPO_TOKEN_BASE, ...(next.repoTokens ?? [])].join('|')})\\b`, 'g'),
        general: new Set([...GENERAL_DEFAULT, ...(next.general ?? [])]),
    }
    Object.assign(rules, next)
    Object.assign(compiled, c)
}
setRules({})

/** Load from a node:sqlite handle (CLI, bootstrap). A missing row or table keeps the current rules (a fresh process has none). */
export function loadRules(db) {
    try { const r = db.prepare("SELECT value FROM Setting WHERE key = 'namingRules'").get(); if (r) setRules(r.value) } catch { /* no Setting table yet */ }
}
/** Load for the panel: `read()` resolves to the setting text (or null). Cached for `ttlMs`. */
let loadedAt = 0
export async function loadRulesAsync(read, ttlMs = 30_000) {
    if (Date.now() - loadedAt < ttlMs) return
    loadedAt = Date.now()
    try { setRules((await read()) ?? '{}') } catch { /* keep the previous rules */ }
}
