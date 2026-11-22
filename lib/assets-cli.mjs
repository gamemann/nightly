// ASSETS: the `nightly assets source|kind|config|scan` commands (arguments in, text out; the logic is in assets-sources/kinds/scan).
import * as AS from './assets.mjs'
import * as K from './assets-kinds.mjs'
import * as S from './assets-sources.mjs'

const csv = (v) => String(v).split(',').map((x) => x.trim()).filter(Boolean)
/** The config keys the flags can set; a key given as "none" is removed. */
function configFrom(opt, die) {
    let cfg = {}
    if (opt.config) { try { cfg = JSON.parse(opt.config) } catch (e) { die(`--config is not JSON: ${e.message}`) } }
    const lists = { models: 'models', textures: 'textures', sounds: 'sounds', exclude: 'exclude', soundKinds: 'soundKinds' }
    for (const [flag, key] of Object.entries(lists)) if (opt[flag] != null) cfg[key] = opt[flag] === 'none' ? null : csv(opt[flag])
    if (opt.defaultKind != null) cfg.defaultKind = opt.defaultKind === 'none' ? null : String(opt.defaultKind)
    if (opt.soundMatch != null) cfg.soundMatch = String(opt.soundMatch)
    return cfg
}
const line = (s) => `${s.name.padEnd(24)} ${s.type.padEnd(5)} ${s.enabled ? 'on ' : 'off'} ${s.root || s.repo}  ${s.lastScanAt ? 'scanned ' + s.lastScanAt.slice(0, 16) : 'never scanned'}${S.rootExists(s) ? '' : '  (root missing)'}`

export function sourceCmd(db, pos, opt, out, die) {
    AS.ready(db)
    const sub = pos.shift() ?? 'list'
    try {
        if (sub === 'list' || sub === 'ls') { const r = S.list(db); return out(r, () => r.map(line).join('\n') || '(no sources: nightly assets source add <name> --root DIR)') }
        if (sub === 'show') { const r = S.get(db, pos[0] ?? die('assets source show <name>')); return out(r, () => `${line(r)}\n${JSON.stringify(S.effective(r.config), null, 2)}`) }
        if (sub === 'add') {
            const r = S.add(db, { name: pos[0] ?? die('assets source add <name> --root DIR'), type: opt.type, root: opt.root, repo: opt.repo, enabled: !opt.disable, config: cleanNulls(configFrom(opt, die)) })
            return out(r, () => `added source ${r.name}; scan it with: nightly assets scan ${r.name}`)
        }
        if (sub === 'set') {
            const r = S.set(db, pos[0] ?? die('assets source set <name> [flags]'), { type: opt.type, root: opt.root, repo: opt.repo, enabled: opt.disable ? false : opt.enable ? true : undefined, config: configFrom(opt, die) })
            return out(r, () => `updated source ${r.name}`)
        }
        if (sub === 'rm' || sub === 'remove') { const r = S.remove(db, pos[0] ?? die('assets source rm <name> [--purge]'), { purge: !!opt.purge }); return out(r, () => `removed${opt.purge ? `, ${r.rows} asset rows deleted` : ' (its asset rows stay; --purge deletes them)'}`) }
        if (sub === 'scan') return scanCmd(db, pos, opt, out)
    } catch (e) { die(e.message) }
    die('assets source list|show|add|set|rm|scan')
}
const cleanNulls = (c) => Object.fromEntries(Object.entries(c).filter(([, v]) => v !== null))

export function kindCmd(db, pos, opt, out, die) {
    AS.ready(db)
    const sub = pos.shift() ?? 'list'
    try {
        if (sub === 'list' || sub === 'ls') { const r = K.list(db); return out(r, () => r.map((k) => `${k.key.padEnd(10)} ${String(k.sort).padStart(3)}  ${k.label.padEnd(12)} budget ${JSON.stringify(k.budget)}`).join('\n')) }
        if (sub === 'set' || sub === 'add') {
            const key = pos[0] ?? die('assets kind set <key> [--label L] [--sort N] [--match REGEX] [--budget JSON]')
            let budget
            if (opt.budget) { try { budget = JSON.parse(opt.budget) } catch (e) { die(`--budget is not JSON: ${e.message}`) } }
            const r = K.save(db, { key, label: opt.label, sort: opt.sort, match: opt.match, budget })
            return out({ key, result: r }, () => `${r} kind ${key}`)
        }
        if (sub === 'rm') { const key = pos[0] ?? die('assets kind rm <key>'); const n = K.remove(db, key); return out({ removed: n }, () => (n ? `removed ${key}` : `no such kind ${key}`)) }
    } catch (e) { die(e.message) }
    die('assets kind list|set|rm')
}

export const config = (db) => { AS.ready(db); return S.exportConfig(db) }

export function scanCmd(db, pos, opt, out) {
    const only = pos.length ? pos : opt.packs ? csv(opt.packs) : undefined
    const r = AS.scanInto(db, { only, onLog: (m) => process.stderr.write(`scan: ${m}\n`) })
    return out(r, () => `scanned ${r.sources} sources: ${r.added} added, ${r.updated} updated, ${r.kept} audited rows kept`)
}
