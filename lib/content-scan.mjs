// Content & balance scan: read the real weapon definitions (GSWeaponDef .tres) of each game's weapon pack and post their numbers as content stats.
// Pack locations are host-specific, so they live in the setting contentWeaponPacks ("game=dir,game=dir"), never in this public repo:
//   nightly set-setting contentWeaponPacks 'arena=/path/arena-weapons,fc=/path/fc-weapons'
// Metrics per weapon (category weapon): damage, max_range, spread, magazine, fire_rate_rpm (authored tick rate * 60 / use_interval_ticks).
// Bands (min/max) are NOT invented: they stay empty until a designer sets them with `nightly content edit <id> --min N --max N`; an existing band is kept.
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import * as F from './feeds.mjs'
import * as S from './store.mjs'

const numIn = (t, k) => { const m = t.match(new RegExp(`^${k} = (-?[0-9.]+)\\s*$`, 'm')); return m ? Number(m[1]) : undefined }
export const parseWeapon = (text) => {
    const num = (k) => { const m = text.match(new RegExp(`^${k} = (-?[0-9.]+)\\s*$`, 'm')); return m ? Number(m[1]) : undefined }
    const res = text.slice(Math.max(0, text.indexOf('\n[resource]')))  // the weapon's own id, not a sub-resource's (damage types have ids too)
    const id = (res.match(/^id = &"([^"]+)"/m) ?? [])[1]
    if (!id) return null
    const ticks = numIn(res, 'use_interval_ticks'), rate = numIn(res, 'authored_tick_rate')
    return { id, name: (res.match(/^display_name = "([^"]*)"/m) ?? [])[1] ?? id, stats: {
        damage: num('damage'), max_range: num('max_range'), spread: num('spread'), magazine: numIn(res, 'magazine'),
        fire_rate_rpm: ticks && rate ? Math.round((rate * 60) / ticks) : undefined } }
}

export function scan(db, { packs, at = new Date() } = {}) {
    const spec = packs ?? S.getSetting(db, 'contentWeaponPacks')
    if (!spec) throw new Error('no packs: nightly set-setting contentWeaponPacks \'game=/dir,game=/dir\'')
    const out = { weapons: 0, stats: 0, games: [] }
    for (const part of String(spec).split(',').map((x) => x.trim()).filter(Boolean)) {
        const [game, dir] = part.split('=')
        if (!game || !dir) throw new Error(`bad pack "${part}" (game=dir)`)
        const wdir = path.join(dir, 'weapons')
        for (const f of readdirSync(wdir).filter((x) => x.endsWith('.tres'))) {
            const w = parseWeapon(readFileSync(path.join(wdir, f), 'utf8'))
            if (!w) continue
            out.weapons++
            for (const [metric, value] of Object.entries(w.stats)) {
                if (value === undefined) continue
                const prev = db.prepare('SELECT min, max FROM "ContentStat" WHERE game = ? AND category = ? AND name = ? AND metric = ?').get(game, 'weapon', w.id, metric)
                F.add(db, 'content', { game, category: 'weapon', name: w.id, metric, value, min: prev?.min ?? undefined, max: prev?.max ?? undefined }, at)
                out.stats++
            }
        }
        out.games.push(game)
    }
    return out
}
