// RSI board, maps domain: judges every map that has a `perf_bench --mesh-census` log against two budgets and raises
//   MESH_OVER_BUDGET  visible mesh instances over rsiMeshBudget
//   ALPHA_BOXES       alpha-blended BoxMesh instances over rsiAlphaBoxBudget (liquid / glass boxes are the usual cause)
// Findings are subject `<game>/<map>`, closed (remeasured) when a newer census puts the map back under budget.
// Pure parse functions are exported for the tests; syncMaps is the only DB writer (CLI side, node:sqlite).
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const GAME = /\binf (\w+)\s+\1 starting/
const MAP = /map ready map=(\w+)/g
const TOTAL = /mesh census: (\d+) visible mesh instances/g
const GROUP = /census\s+(\d+)\s+(\w+)\s+(\w+)\b/

/** One census log -> {game, map, meshes, alphaBoxes, alphaTotal} or null when it has no census / map. */
export function parseCensus(text, fallbackGame = 'game') {
    const maps = [...text.matchAll(MAP)].map((m) => m[1])
    const totals = [...text.matchAll(TOTAL)]
    if (!maps.length || !totals.length) return null
    const last = totals[totals.length - 1]
    const from = text.lastIndexOf('mesh census:')           // the census is printed twice; judge the last block
    const block = text.slice(from, from + 20000).split('\n')
    let alphaBoxes = 0, alphaTotal = 0
    for (const l of block.slice(1)) {
        if (/mesh census:/.test(l)) break
        const g = GROUP.exec(l)
        if (!g) continue
        if (g[3] === 'alpha') { alphaTotal += Number(g[1]); if (g[2] === 'BoxMesh') alphaBoxes += Number(g[1]) }
    }
    return { game: GAME.exec(text)?.[1] ?? fallbackGame, map: maps[maps.length - 1], meshes: Number(last[1]), alphaBoxes, alphaTotal }
}

export const CENSUS_LOGS = 'draws-bench.*\\.log$'
/** Latest census per `<game>/<map>` over the logs in a directory whose names match `logs` (filename timestamp orders them). */
export function scanLogs(dir, { logs = CENSUS_LOGS, game = 'game' } = {}) {
    let names = [], re
    try { re = new RegExp(logs || CENSUS_LOGS) } catch { re = new RegExp(CENSUS_LOGS) }
    try { names = readdirSync(dir).filter((n) => re.test(n)).sort() } catch { return [] }
    const latest = new Map()
    for (const n of names) {
        let c
        try { c = parseCensus(readFileSync(path.join(dir, n), 'utf8'), game) } catch { continue }
        if (c) latest.set(`${c.game}/${c.map}`, { ...c, subject: `${c.game}/${c.map}`, log: n })
    }
    return [...latest.values()]
}

/** Findings a census raises under the given budgets (0 disables a budget). */
export function judge(c, { budget = 600, alphaBudget = 50 } = {}) {
    const out = []
    if (budget && c.meshes > budget) out.push({ code: 'MESH_OVER_BUDGET', severity: c.meshes > budget * 2 ? 'error' : 'warn',
        msg: `${c.meshes} visible mesh instances (budget ${budget}) in ${c.log}`,
        nextAction: 'Merge static meshes by material (MultiMesh / baked chunks) or cull the heaviest groups in the census, then re-run perf_bench --mesh-census' })
    if (alphaBudget && c.alphaBoxes > alphaBudget) out.push({ code: 'ALPHA_BOXES', severity: c.alphaBoxes > alphaBudget * 4 ? 'error' : 'warn',
        msg: `${c.alphaBoxes} alpha-blended BoxMesh instances (budget ${alphaBudget}) in ${c.log}`,
        nextAction: 'Replace per-brush alpha boxes (liquid, glass) with one merged surface or a shader plane per body' })
    return out
}

const CODES = ['MESH_OVER_BUDGET', 'ALPHA_BOXES']
const score = (c, budget) => Math.max(0, Math.round(100 - ((c.meshes / (budget || 600)) - 1) * 50))

/** Write the maps findings: raise what is over budget, close what is back under. Returns counts. */
export function syncMaps(db, { budget = 600, alphaBudget = 50, dir = '', logs, game, censuses = dir ? scanLogs(dir, { logs, game }) : [], at = new Date() } = {}) {
    const t = at.toISOString(), res = { maps: censuses.length, raised: 0, closed: 0 }
    db.exec('BEGIN')
    try {
        for (const c of censuses) {
            const raised = new Map(judge(c, { budget, alphaBudget }).map((f) => [f.code, f]))
            for (const code of CODES) {
                const old = db.prepare("SELECT * FROM RsiFinding WHERE subject = ? AND code = ? AND tier = ''").get(c.subject, code)
                const f = raised.get(code)
                if (f) {
                    const s = score(c, budget)
                    if (!old) db.prepare("INSERT INTO RsiFinding (domain, subject, code, tier, severity, msg, nextAction, state, status, beforeScore, afterScore, firstSeenAt, lastSeenAt, history) VALUES ('maps',?,?,'',?,?,?,'found','open',?,?,?,?,'[]')")
                        .run(c.subject, code, f.severity, f.msg, f.nextAction, s, s, t, t)
                    else db.prepare("UPDATE RsiFinding SET severity=?, msg=?, nextAction=?, status='open', state='found', afterScore=?, lastSeenAt=?, fixedAt=NULL WHERE id=?")
                        .run(f.severity, f.msg, f.nextAction, s, t, old.id)
                    res.raised++
                } else if (old?.status === 'open') {
                    db.prepare("UPDATE RsiFinding SET status='resolved', state='remeasured', afterScore=?, fixedAt=?, lastSeenAt=? WHERE id=?").run(score(c, budget), t, t, old.id)
                    res.closed++
                }
            }
        }
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return res
}
