// Project types, slugs and the seed classification, shared by the CLI (lib/projects.mjs) and the
// panel (src/server/projectsRouter.ts). No database handle here.

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

/** Never seeded: worktrees, hidden dirs, clones of the panel itself, backups. */
const SKIP = /^\.|^nightly-|-wt(-|$)|-bak$|^scratch$|^dev-env$|^addons_dummy$|^inspirations$/

/**
 * Classify one repo for seeding. kind: 'godot' (a Godot repo dir), 'web' (a repo with package.json),
 * 'none' (a dir with neither: only addon/game name patterns count) or 'name' (only the name is known, e.g. from Release rows).
 * siblings: names that exist, to drop old dot-* repos that have a gs-* twin.
 * Returns { slug, type, folder: [path] } or null to skip.
 */
export function classifyRepo(name, kind = 'name', siblings = new Set()) {
    const n = String(name).toLowerCase()
    if (SKIP.test(n) || !SLUG.test(n)) return null
    if (n.startsWith('dot-') && siblings.has(`gs-${n.slice(4)}`)) return null
    const web = n.startsWith('website-') || n.startsWith('tmc-')
    if (kind === 'web' || (kind === 'name' && web)) return { slug: n, type: 'website', folder: ['Websites'] }
    if (n.endsWith('-maps')) return { slug: n, type: 'game-addon', folder: ['Game Addons', 'Map packs'] }
    if (n.endsWith('-weapons')) return { slug: n, type: 'game-addon', folder: ['Game Addons', 'Weapon packs'] }
    if (n.startsWith('gs-') || n.startsWith('dot-')) return { slug: n, type: 'game-addon', folder: ['Game Addons', 'GameSpice addons'] }
    if (n.startsWith('zz-')) return { slug: n, type: 'game-addon', folder: ['Game Addons', 'Content packs'] }
    if (n.startsWith('mg-')) return { slug: n, type: 'game', folder: ['Games', 'Minigames'] }
    if (n.startsWith('game-') || kind === 'godot') return { slug: n, type: 'game', folder: ['Games'] }
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
