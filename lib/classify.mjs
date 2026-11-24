// Which game or area an item belongs to: its repo tags first, then its key and title. Shared by the panel
// (src/lib/games.ts) and the CLI (addItem fills in repos from it), so both file an item the same way.
export const OTHER = "other"
export const DEV = "dev"
export const BACKBONE = "backbone"

import { compiled, rules } from "./naming-rules.mjs"

const repoName = (t) => t.trim().replace(/\/+$/, "").split("/").pop() ?? ""
/** Game slugs: the keyword targets plus `games` of the naming rules (lib/naming-rules.mjs). */
const gameSet = () => new Set([...compiled.gameKeywords.map((k) => k[1]), ...rules.games])
export const isGame = (n) => gameSet().has(n)
// Repo names that file under a game or area (renamed checkouts, map/weapon packs of a game, "game-dev" -> dev): rules.gameAliases.
const ALIAS = { "game-dev": DEV, "game-backbone": BACKBONE }
const aliasOf = (n) => rules.gameAliases[n] ?? ALIAS[n]
const test = (re, s) => !!re && re.test(s)
const isBackbone = (n) => test(compiled.backbone, n)
const isDev = (n) => test(compiled.dev, n)

/** Game repo named by the key or title (`copter-rot-1`, "Dangerous Delivery: ..."), or "". */
export function gameFromText(key, title) {
    const k = String(key).toLowerCase(), t = String(title).toLowerCase()
    for (const [re, g] of compiled.gameKeywords) if (re.test(k)) return g
    const games = gameSet()
    for (const m of t.matchAll(compiled.repoToken)) if (games.has(m[1])) return m[1]
    for (const [re, g] of compiled.gameKeywords) if (re.test(t)) return g
    return ""
}

/** Repo names written in the title or key, for an item filed with no repos. */
export function reposFromText(key, title) {
    const out = []
    for (const m of `${title} ${key}`.toLowerCase().matchAll(compiled.repoToken)) if (!out.includes(m[1])) out.push(m[1])
    return out
}

/** The slug an item files under: a game repo, `dev`, `backbone` or `other`. */
export function classify(repos, key, title, known) {
    const names = String(repos).split(",").map(repoName).filter(Boolean)
    for (const n of names) if (isGame(n)) return n
    for (const n of names) if (aliasOf(n)) return aliasOf(n)
    for (const n of names) {
        const m = /^(.+)-maps$/.exec(n)
        if (m) for (const c of [m[1], `game-${m[1]}`, `mg-${m[1]}`]) if (known.has(c) || isGame(c)) return c
    }
    const fromText = gameFromText(key ?? "", title ?? "")
    if (fromText && !names.some((n) => isBackbone(n) || isDev(n))) return fromText
    if (names.some((n) => isBackbone(n))) return BACKBONE
    if (names.some((n) => isDev(n))) return DEV
    if (fromText) return fromText
    // Junk tags ("all", "external", a path) name no repo, so they count as untagged.
    if (!names.some((n) => isBackbone(n) || isDev(n) || /-maps$/.test(n))) {
        const r = reposFromText(key ?? "", title ?? "")
        if (r.some((n) => isBackbone(n))) return BACKBONE
        if (r.some((n) => isDev(n))) return DEV
        if (test(compiled.backboneText, `${title}`) || test(compiled.backboneKey, key ?? "")) return BACKBONE
        if (test(compiled.devKey, key ?? "") || test(compiled.devText, `${title}`)) return DEV
    }
    return OTHER
}

/** Repos string to store for an item filed with none: the game repo, else repo names found in its text. */
export function suggestRepos(key, title) {
    const g = gameFromText(key, title)
    if (g) return g
    const r = reposFromText(key, title).join(", ")
    if (r) return r
    const area = classify("", key, title, new Set())
    return area === OTHER ? "" : area
}
