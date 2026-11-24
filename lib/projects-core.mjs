// Project types, slugs and the seed classification, shared by the CLI (lib/projects.mjs) and the
// panel (src/server/projectsRouter.ts). No database handle here.

import { compiled } from './naming-rules.mjs'

export const PROJECT_TYPES = ['website', 'game', 'game-addon']
export const SLUG = /^[a-z0-9][a-z0-9._-]{0,62}$/

export function checkSlug(s) {
    const v = String(s ?? '').trim().toLowerCase()
    if (!SLUG.test(v)) throw new Error('slug: 1-63 of a-z 0-9 . _ -, starting with a letter or digit')
    return v
}
export function checkType(t) {
    if (!PROJECT_TYPES.includes(t)) throw new Error(`type: one of ${PROJECT_TYPES.join(', ')}`)
    return t
}

/** Seeded folder paths (parent before child). */
export const SEED_FOLDERS = [
    ['Websites'], ['Games'], ['Games', 'Minigames'],
    ['Game Addons'], ['Game Addons', 'GameSpice addons'], ['Game Addons', 'Map packs'], ['Game Addons', 'Weapon packs'], ['Game Addons', 'Content packs'],
]

/**
 * Classify one repo for seeding. kind: 'godot' (a Godot repo dir), 'web' (a repo with package.json),
 * 'none' (a dir with neither: only addon/game name patterns count) or 'name' (only the name is known, e.g. from Release rows).
 * siblings: names that exist, to drop old repos that have a renamed twin.
 * The name patterns (skip, website, twins, folders) are data: skipRepo / webRepo / twins / repoClasses of the namingRules Setting.
 * Returns { slug, type, folder: [path] } or null to skip.
 */
export function classifyRepo(name, kind = 'name', siblings = new Set()) {
    const n = String(name).toLowerCase()
    if (compiled.skipRepo.test(n) || !SLUG.test(n)) return null
    for (const [re, to] of compiled.twins) if (re.test(n) && siblings.has(n.replace(re, to))) return null
    if (kind === 'web' || (kind === 'name' && compiled.webRepo.test(n))) return { slug: n, type: 'website', folder: ['Websites'] }
    for (const [re, type, folder] of compiled.repoClasses) if (re.test(n)) return { slug: n, type, folder }
    if (kind === 'godot') return { slug: n, type: 'game', folder: ['Games'] }
    return null
}

/** A display name from a repo name: game-fatal-contact -> Fatal Contact, gs-npc-ai -> gs-npc-ai (addons keep their id). */
export function projectName(slug, type) {
    if (type === 'game-addon') return slug
    const base = slug.replace(/^(game|website|mg)-/, '')
    return base.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ')
}

export function parseSettings(s) {
    try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {} } catch { return {} }
}
