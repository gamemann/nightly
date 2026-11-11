// Which game or area an item belongs to: its repo tags first, then its key and title. Shared by the panel
// (src/lib/games.ts) and the CLI (addItem fills in repos from it), so both file an item the same way.
export const OTHER = "other"
export const DEV = "dev"
export const BACKBONE = "backbone"

const GAME_KEYWORDS = [
    [/zombie|\bzz-(?!modern|zed|medieval|historical)/, "game-zombie-zone"],
    [/arena|fatal[- ]?contact/, "game-arena"],
    [/g2gfast|airdrift/, "game-g2gfast"],
    [/hungario/, "game-hungario"],
    [/hide-?n-?seek/, "game-hide-n-seek"],
    [/murder/, "game-murder-mystery"],
    [/wipeout/, "mg-wipeout"],
    [/deathrun/, "mg-deathrun"],
    [/prop[- ]hunt|\bph-/, "mg-prop-hunt"],
    [/buses/, "mg-buses-from-hell"],
    [/copter/, "mg-smash-copter"],
    [/dangerous[- ]delivery|^dd-/, "mg-dangerous-delivery"],
    [/look-?at-?me/, "mg-look-at-me"],
    [/playground|playlot|^pg-/, "game-playground"],
    [/lobby/, "game-simple-lobby"],
]
const BACKBONE_RE = /^(website-|tmc-|storez|buildz|defcon|spy|stack|backbone|tekworks)/
const DEV_RE = /^(dot-|zee-|zed-|zz-|godot|dev02|nightly|natural-disasters|dev$)/
const REPO_TOKEN = /\b((?:game|mg)-[a-z0-9]+(?:-[a-z0-9]+){0,3}|dot-[a-z0-9][a-z0-9-]*|website-(?:city|processing|learn|status)|tmc-(?:app|cli|global)|storez|buildz|defcon|zz-[a-z0-9-]+|zee-dot-weapons|zed-dot-weapons)\b/g

const repoName = (t) => t.trim().replace(/\/+$/, "").split("/").pop() ?? ""
const GAMES = new Set([...GAME_KEYWORDS.map((k) => k[1]), "game-hungario"])
export const isGame = (n) => GAMES.has(n)
// Zee's Playlot was game-playground: items keep filing under the checkout's directory name
// (godot/game-playground) until that directory is renamed. Zee's Airdrift was game-g2gfast, the same way.
// Zee's Fatal Contact was game-arena, the same way.
const ALIAS = {
    "game-dev": DEV,
    "game-backbone": BACKBONE,
    "game-playlot": "game-playground",
    "game-playlot-maps": "game-playground",
    "game-airdrift": "game-g2gfast",
    "airdrift-maps": "game-g2gfast",
    "game-fatalcontact": "game-arena",
    "game-fatal-contact": "game-arena",
    "fc-weapons": "game-arena",
    "fc-dm-maps": "game-arena",
    "fc-surf-dm-maps": "game-arena",
}

/** Game repo named by the key or title (`copter-rot-1`, "Dangerous Delivery: ..."), or "". */
export function gameFromText(key, title) {
    const k = String(key).toLowerCase(), t = String(title).toLowerCase()
    for (const [re, g] of GAME_KEYWORDS) if (re.test(k)) return g
    for (const m of t.matchAll(REPO_TOKEN)) if (isGame(m[1])) return m[1]
    for (const [re, g] of GAME_KEYWORDS) if (re.test(t)) return g
    return ""
}

/** Repo names written in the title or key, for an item filed with no repos. */
export function reposFromText(key, title) {
    const out = []
    for (const m of `${title} ${key}`.toLowerCase().matchAll(REPO_TOKEN)) if (!out.includes(m[1])) out.push(m[1])
    return out
}

/** The slug an item files under: a game repo, `dev`, `backbone` or `other`. */
export function classify(repos, key, title, known) {
    const names = String(repos).split(",").map(repoName).filter(Boolean)
    for (const n of names) if (isGame(n)) return n
    for (const n of names) if (ALIAS[n]) return ALIAS[n]
    for (const n of names) {
        if (n === "arena-surf-dm-maps" || n === "arena-weapons") return "game-arena"
        const m = /^(.+)-maps$/.exec(n)
        if (m) for (const c of [m[1], `game-${m[1]}`, `mg-${m[1]}`]) if (known.has(c) || isGame(c)) return c
    }
    const fromText = gameFromText(key ?? "", title ?? "")
    if (fromText && !names.some((n) => BACKBONE_RE.test(n) || DEV_RE.test(n))) return fromText
    if (names.some((n) => BACKBONE_RE.test(n))) return BACKBONE
    if (names.some((n) => DEV_RE.test(n))) return DEV
    if (fromText) return fromText
    // Junk tags ("all", "external", a path) name no repo, so they count as untagged.
    if (!names.some((n) => BACKBONE_RE.test(n) || DEV_RE.test(n) || /-maps$/.test(n))) {
        const r = reposFromText(key ?? "", title ?? "")
        if (r.some((n) => BACKBONE_RE.test(n))) return BACKBONE
        if (r.some((n) => DEV_RE.test(n))) return DEV
        if (/\b(website|backbone|api|nginx|postgres|redis|cdn|admin panel|spy|chart|workshop|flagged servers|dev_games|stats-table|web:|node profiles panel)\b|admin>/i.test(`${title}`) || /^(browser-verify|node-profiles)/.test(key ?? "")) return BACKBONE
        if (/^chk-/.test(key ?? "")) return DEV
        if (/\b(addon|godot|game\.sh|rollout|zee|zed|weapons?|viewmodel|hq gun|dotfx|dot[a-z]+|adopt|leftovers|gpu|filmstrips?|shots?|motion|capture|stats|achievements|ugc|wearables|campaign|zees-games|map poses|every game|the games|family|screenshot)\b|dot-/i.test(`${title}`)) return DEV
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
