import { OTHER, classify, isGame } from '../../lib/classify.mjs'

export { OTHER }

/** `game-dev/godot/game-fatal-contact` -> `game-fatal-contact`. */
export const repoName = (t: string) => t.trim().replace(/\/+$/, '').split('/').pop() ?? ''

/** All game repos named anywhere in the given repos strings. */
export function knownGames(all: string[]): Set<string> {
    const out = new Set<string>()
    for (const r of all) for (const t of r.split(',')) { const n = repoName(t); if (isGame(n)) out.add(n) }
    return out
}

/** The game or area an item (or QA run) belongs to; see lib/classify.mjs. */
export function gameOf(repos: string, known: Set<string>, key = '', title = ''): string {
    return classify(repos, key, title, known)
}

/** `game-zombie-zone` -> `Zombie Zone`. */
export const gameLabel = (slug: string) => slug === OTHER ? 'Other' : slug.replace(/^(game|mg)-/, '').split('-').map((w) => w[0]?.toUpperCase() + w.slice(1)).join(' ')
