/** Which game (or area) an item belongs to, derived from Item.repos; only the exceptions are listed here. */
export const GAME_ALIASES: Record<string, string> = {
    'arena-surf-dm-maps': 'game-arena',
    'arena-weapons': 'game-arena',
}
export const OTHER = 'other'

/** `game-dev/godot/game-arena` -> `game-arena`. */
export const repoName = (t: string) => t.trim().replace(/\/+$/, '').split('/').pop() ?? ''
const isGame = (n: string) => /^(game|mg)-/.test(n)

/** All game repos named anywhere in the given repos strings. */
export function knownGames(all: string[]): Set<string> {
    const out = new Set<string>()
    for (const r of all) for (const t of r.split(',')) { const n = repoName(t); if (isGame(n)) out.add(n) }
    return out
}

/** The game an item (or QA run) belongs to: a game repo, an alias, or a `<game>-maps` repo of a known game. */
export function gameOf(repos: string, known: Set<string>): string {
    const names = repos.split(',').map(repoName).filter(Boolean)
    for (const n of names) if (isGame(n)) return n
    for (const n of names) {
        if (GAME_ALIASES[n]) return GAME_ALIASES[n]
        const m = /^(.+)-maps$/.exec(n)
        if (m) for (const c of [`game-${m[1]}`, `mg-${m[1]}`]) if (known.has(c)) return c
    }
    return OTHER
}

/** `game-zombie-zone` -> `Zombie Zone`. */
export const gameLabel = (slug: string) => slug === OTHER ? 'Other' : slug.replace(/^(game|mg)-/, '').split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ')
