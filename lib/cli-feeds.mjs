// CLI for the health feeds and gate findings: nightly releases|crash|web|playtest|content <list|add|summary|...>, nightly feed add <kind> -, nightly gates sync.
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import * as F from './feeds.mjs'
import * as G from './gates.mjs'
import * as PS from './perf-store.mjs'
import * as RS from './releases-sync.mjs'

export const FEED_COMMANDS = ['releases', 'release', 'deploys', 'crash', 'crashes', 'web', 'webcheck', 'webchecks', 'playtest', 'playtests', 'feedback', 'content']
const clip = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''))
const LINE = {
    release: (r) => `${r.repo.padEnd(18)} ${r.version.padEnd(12)} ${r.channel.padEnd(8)} ci ${r.ci.padEnd(8)} on ${(r.deployedTo || '-').padEnd(16)} rollback ${r.rollback || '-'}  ${clip(r.changelog.replace(/\s+/g, ' '), 50)}`,
    crash: (r) => `${r.game.padEnd(12)} ${String(r.count).padStart(5)}x ${r.status.padEnd(7)} v${(r.version || '-').padEnd(8)} ${(r.platform || '-').padEnd(8)} ${clip(r.signature, 70)}`,
    web: (r) => `${r.game.padEnd(12)} ${r.metric.padEnd(20)} ${String(r.value).padStart(10)}  ${r.at.slice(0, 16)}  ${r.commit.slice(0, 9)}`,
    playtest: (r) => `${r.game.padEnd(12)} ${(r.build || '-').padEnd(10)} ${(r.tester || '-').padEnd(12)} ${r.rating ?? '-'}/5  ${clip(r.text.replace(/\s+/g, ' '), 70)}`,
    content: (r) => `${r.game.padEnd(12)} ${(r.category || '-').padEnd(10)} ${r.name.padEnd(18)} ${r.metric.padEnd(10)} ${String(r.value).padStart(8)}  [${r.min ?? '-'}, ${r.max ?? '-'}]`,
}
export const FEED_HELP = `  releases list|add|deploy [--repo R] [--version V] [--channel C] [--ci passing|failing|pending] [--to ENV] [--changelog T] [--rollback V] [--game G]
  releases set --repo R --version V [--channel C] [--changelog T] [--ci S] [--rollback V] [--game G] [--commit SHA] [--at DATE]   edit a release (the panel's Edit)
  releases undeploy --repo R --version V --from ENV    remove an environment from a release     releases rm --repo R --version V [--channel C]   delete a record
  releases sync [--no-ci]                       import v*.*.* tags of every repo under setting releasesRoots (default gamedev ~/godot and core ~/projects) and fill CI from GitHub; idempotent, never touches deployedTo (the Releases schedule runs it hourly)
  <kind> edit <id> [--field value ...]           change fields of one row (ids come from list); <kind> delete <id>   remove it. Same functions as the panel's Edit / Delete.
  crash list|add|edit|delete|summary|set|scan [--from FILE|-] [--game G] [--signature S] [--version V] [--platform P] [--count N] [--status open|fixed|ignored]
  crash scan [--logs DIR,DIR] [--no-journal] [--since 90d]   import engine crash dumps and OOM kills as absolute counts (idempotent; run as the user owning the logs)
  web (alias webcheck) list|add|edit|delete|budget|probe|summary --game G --metric M [--value N] [--max N --unit U] [--url U] [--commit C]     bundle size, web vitals, uptime as budgeted series
  playtest record --game G --from-soak <file|-> [--mode M] [--build B] | --map M --bots N --duration_s S --result pass|fail --crashes N --avg_fps F   post one unattended bot run (tester bots); idempotent
  playtest import-perf                          every perf run with bots becomes a bot playtest (history; idempotent)
  playtest list|add|edit|delete|summary --game G [--build B] [--tester T] [--rating 1-5] [--tags a,b] [--text T]
  content scan [--packs game=dir,...]            read the weapon definitions of each game's weapon pack (setting contentWeaponPacks) into stats: damage, max_range, spread, magazine, fire_rate_rpm; bands are never invented
  content list|add|edit|delete|summary --game G --name N --metric M --value V [--category C] [--min N] [--max N]     balance stats; outside [min,max] opens a finding
  feed add <kind> <file|->                      ingest one JSON record or an array (HTTP: POST /api/ingest/<kind> with Authorization: Bearer <perf token>)
  gates sync --kind perf|visual|netchaos --game G [--file qa.json|-]    open/close one RSI finding per failing check of a gate result`

export async function runFeedCommand(cmd, { db, pos, opt, out, die, readStdin }) {
    if (cmd === 'gates') return gates({ db, pos, opt, out, die, readStdin })
    if (cmd === 'feed') {
        if (pos.shift() !== 'add') die('feed add <kind> <file|->')
        return ingest(F.kindOf(pos.shift() ?? die('feed add <kind> <file|->')), pos[0] ?? '-', { db, opt, out, die, readStdin })
    }
    const kind = F.kindOf(cmd)
    const sub = pos.shift() ?? 'list'
    const game = opt.game ? String(opt.game) : undefined
    if (sub === 'list') {
        const rows = F.list(db, kind, { game, status: opt.status ? String(opt.status) : undefined, limit: opt.limit ? Number(opt.limit) : 50 })
        return out(rows, () => rows.map((r) => `${String(r.id ?? '').padStart(5)}  ${LINE[kind](r)}`).join('\n') || `(no ${kind} records)`)
    }
    if (sub === 'edit' || sub === 'delete' || sub === 'rm' && kind !== 'release') {
        const id = pos.shift() ?? opt.id ?? die(`${cmd} ${sub} <id> ${sub === 'edit' ? '--field value ...' : ''}(ids: ${cmd} list)`)
        try {
            if (sub !== 'edit') { const r = F.remove(db, kind, id); return out(r, () => `${kind} ${r.id} deleted`) }
            const patch = { ...opt }; delete patch.id
            const r = F.edit(db, kind, id, patch)
            return out(r, () => `${kind} ${r.id} updated`)
        } catch (e) { return die(e.message) }
    }
    if (sub === 'summary') { const s = F.summary(db, kind, game); return out(s, () => (Array.isArray(s) ? s.map((r) => Object.values(r).join('  ')).join('\n') : JSON.stringify(s)) || '(nothing yet)') }
    if (kind === 'web' && sub === 'budget') {
        if (opt.delete) { try { const r = F.removeBudget(db, String(opt.game ?? die('--game required')), String(opt.metric ?? die('--metric required'))); return out(r, () => `budget ${r.game}/${r.metric} deleted`) } catch (e) { return die(e.message) } }
        if (opt.max === undefined) { const b = F.budgets(db, game); return out(b, () => b.map((x) => `${x.game.padEnd(12)} ${x.metric.padEnd(20)} <= ${x.max}${x.unit}`).join('\n') || '(no budgets)') }
        const b = F.setBudget(db, opt.game, opt.metric, opt.max, opt.unit ? String(opt.unit) : '')
        return out(b, () => `${b.game}/${b.metric} <= ${b.max}${b.unit}`)
    }
    if (kind === 'release' && sub === 'sync') {
        const st = RS.sync(db, { ci: !opt.noCi && opt.ci !== false, log: (m) => process.stderr.write(m + '\n') })
        return out(st, () => `${st.repos} repos, ${st.tags} tags, ${st.added} new; ci: ${st.ciCalls} gh calls, ${st.ciSet} set${st.ciSkipped ? `; ${st.ciSkipped}` : ''}`)
    }
    if (kind === 'release' && ['set', 'edit', 'undeploy', 'rm'].includes(sub)) {
        const key = { repo: opt.repo, version: opt.version, channel: opt.channel ? String(opt.channel) : undefined }
        if (sub === 'rm') { const r = F.removeRelease(db, key); return out(r, () => `removed ${opt.repo} ${opt.version}`) }
        if (sub === 'undeploy') { const r = F.undeploy(db, { ...key, from: opt.from }); return out(r, () => `${opt.repo} ${opt.version} now on: ${r.deployedTo || '-'}`) }
        const r = F.updateRelease(db, { ...key, ...Object.fromEntries(['changelog', 'ci', 'rollback', 'game', 'commit', 'at'].filter((k) => opt[k] !== undefined).map((k) => [k, opt[k]])) })
        return out(r, () => `${opt.repo} ${opt.version}: ${r.changed.join(', ') || 'nothing'} updated`)
    }
    if (kind === 'release' && sub === 'deploy') {
        const r = F.deploy(db, { repo: opt.repo, version: opt.version, to: opt.to, channel: opt.channel ? String(opt.channel) : undefined, game: opt.game ? String(opt.game) : '' })
        return out(r, () => `${opt.repo} ${opt.version} deployed to ${opt.to}`)
    }
    if (kind === 'crash' && sub === 'scan') return scanCrashes({ db, opt, out, die })
    if (kind === 'content' && sub === 'scan') {
        const C = await import('./content-scan.mjs')
        try { const r = C.scan(db, { packs: opt.packs ? String(opt.packs) : undefined }); return out(r, () => `${r.weapons} weapons, ${r.stats} stats from ${r.games.join(', ')}`) } catch (e) { return die(e.message) }
    }
    if (kind === 'playtest' && (sub === 'record' || sub === 'import-perf')) {
        const B = await import('./playtest-bots.mjs')
        if (sub === 'import-perf') { const r = B.importPerf(db); return out(r, () => `${r.runs} perf runs with bots, ${r.created} new bot playtests`) }
        const facts = opt.fromSoak ? B.parseSoak(opt.fromSoak === '-' || opt.fromSoak === true ? readStdin() : readFileSync(String(opt.fromSoak), 'utf8')) : {}
        for (const k of ['map', 'mode', 'bots', 'result', 'crashes', 'avg_fps', 'tick_ms_mean', 'duration_s']) if (opt[k] !== undefined) facts[k] = opt[k]
        try { const r = B.record(db, { game: String(opt.game ?? die('--game required')), build: opt.build ? String(opt.build) : '', at: opt.at, ...facts }); return out({ ...r, facts }, () => `bot playtest ${r.id} ${r.created ? 'recorded' : 'already stored'}: ${facts.result ?? ''}`) } catch (e) { return die(e.message) }
    }
    if (kind === 'web' && sub === 'probe') return probeWeb({ db, opt, out, die })
    if (kind === 'crash' && sub === 'set') {
        const sig = opt.signature ?? die('crash set --game G --signature S --status fixed|ignored|open [--version V --platform P]')
        const w = ['game = ?', 'signature = ?'], a = [game ?? die('--game required'), String(sig)]
        for (const k of ['version', 'platform']) if (opt[k] !== undefined) { w.push(`${k} = ?`); a.push(String(opt[k])) }
        if (!['open', 'fixed', 'ignored'].includes(String(opt.status))) die('--status open|fixed|ignored')
        const r = db.prepare(`UPDATE CrashGroup SET status = ? WHERE ${w.join(' AND ')}`).run(String(opt.status), ...a)
        return out({ changed: Number(r.changes) }, () => `${r.changes} crash group(s) -> ${opt.status}`)
    }
    if (sub === 'add') {
        const rec = { ...opt }
        for (const k of ['json', 'tokenOnly', 'requireToken', 'to']) delete rec[k]
        return out(F.add(db, kind, rec), () => `${kind} recorded`)
    }
    return die(`${cmd} list|add|edit|delete|summary${kind === 'web' ? '|budget|probe' : kind === 'release' ? '|deploy|set|undeploy|rm|sync' : kind === 'crash' ? '|set|scan' : kind === 'content' ? '|scan' : kind === 'playtest' ? '|record|import-perf' : ''}`)
}

function scanCrashes({ db, opt, out, die }) {
    const a = [new URL('./crash-scan.mjs', import.meta.url).pathname]
    if (!opt.noJournal) a.push('--journal')
    for (const k of ['logs', 'since', 'platform']) if (opt[k]) a.push(`--${k}`, String(opt[k]))
    a.push('--projects', JSON.stringify(db.prepare('SELECT slug, repoPath, settings FROM "Project"').all()))
    let recs
    try { recs = JSON.parse(opt.from ? readFileSync(opt.from === '-' || opt.from === true ? 0 : String(opt.from), 'utf8') : execFileSync(process.execPath, a, { encoding: 'utf8', maxBuffer: 1 << 26, timeout: 600_000 })) } catch (e) { return die(`crash scan failed: ${e.message.split('\n')[0]}`) }
    const res = recs.map((r) => F.add(db, 'crash', r))
    return out({ groups: res.length, created: res.filter((r) => r.created).length }, () => `${res.length} crash group(s), ${res.filter((r) => r.created).length} new`)
}

async function probeWeb({ db, opt, out, die }) {
    const W = await import('./web-probe.mjs')
    const r = await W.probe(db, { targets: opt.targets ? String(opt.targets) : undefined, frame: !!opt.frame, dry: !!opt.dryRun })
    return out(r, () => r.samples.map((s) => `${s.game.padEnd(12)} ${s.metric.padEnd(12)} ${String(s.value).padStart(8)}  ${s.url}`).join('\n') + `\n${r.failed} failing`)
}

function ingest(kind, file, { db, opt, out, die, readStdin }) {
    if (opt.requireToken || opt.tokenOnly) PS.authorizeIngest(db, process.env.NIGHTLY_PERF_TOKEN, '', { strict: !!opt.tokenOnly })
    const text = file === '-' ? readStdin() : readFileSync(file, 'utf8')
    let data
    try { data = JSON.parse(text) } catch { die('body is not JSON') }
    const recs = Array.isArray(data) ? data : [data]
    if (recs.length > 1000) die('at most 1000 records per call')
    const res = recs.map((r) => F.add(db, kind, r && typeof r === 'object' ? r : die('records must be objects')))
    return out({ kind, records: res.length, results: res }, () => `${res.length} ${kind} record(s) stored`)
}

function gates({ db, pos, opt, out, die, readStdin }) {
    if ((pos.shift() ?? 'sync') !== 'sync') die('gates sync --kind perf|visual|netchaos --game G [--file F|-]')
    let doc = {}
    if (opt.file) { try { doc = JSON.parse(opt.file === '-' ? readStdin() : readFileSync(String(opt.file), 'utf8')) } catch { die('--file is not JSON') } }
    const r = G.syncGate(db, { kind: String(opt.kind ?? doc.kind ?? die('--kind required')), game: String(opt.game ?? doc.game ?? die('--game required')), failures: doc.failures ?? [], infra: !!opt.infra })
    return out(r ?? { skipped: true }, () => (r ? `${r.domain}: ${r.raised} raised, ${r.closed} closed` : 'not a gate kind: nothing to do'))
}
