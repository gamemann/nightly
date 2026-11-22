// Gate findings: a QA result (perf budget, visual diff, netchaos) that has failing checks opens one RSI finding per failing check and
// closes it again when a later run of the same gate passes that check. The job itself is not "failed": it ran and found regressions
// (run status "findings"); "failed" stays for infrastructure (the gate could not run).
//
// Re-baseline policy (written into every finding): a failing gate is a regression until proven otherwise. Fix the code first. Only when
// the change is intended, re-baseline in the game repo (perf: the gate script's --update; visual: regenerate the goldens; netchaos: update
// the profile thresholds), commit that with the reason, and note it on the finding's item. Never re-baseline just to turn a gate green.
import { ensure, raise } from './rsi.mjs'

/** QA kind -> board domain. Anything else (fuzz, suite) does not open board findings. */
export const GATE_DOMAINS = { perf: 'perf', visual: 'visual', netchaos: 'netchaos' }
export const REBASELINE_POLICY = 'Fix the regression. Re-baseline only if the change is intended: update the baseline in the game repo, commit it with the reason and note it on the item. Never re-baseline just to go green.'

const code = (name) => String(name || 'check').replace(/[^\w.:/-]+/g, '_').slice(0, 80)

/** Sync findings from one gate result. failures = [{ name, reasons?, note?, repro? }]. Returns { raised, closed, domain } or null when the kind is not a gate. */
export function syncGate(db, { kind, game, failures = [], infra = false }, at = new Date()) {
    const domain = GATE_DOMAINS[kind]
    if (!domain || !game || infra) return null
    ensure(db)
    const t = at.toISOString()
    const subject = game
    const seen = new Set()
    const res = { raised: 0, closed: 0, domain }
    db.exec('BEGIN')
    try {
        for (const f of failures) {
            const c = code(f.name)
            seen.add(c)
            const msg = [...(f.reasons ?? []), f.note].filter(Boolean).join('; ').slice(0, 400)
            raise(db, { domain, subject, code: c, tier: '', severity: 'error', score: null, msg, itemKey: '',
                nextAction: `${f.repro ? `Repro: ${String(f.repro).slice(0, 160)}. ` : ''}${REBASELINE_POLICY}` }, t)
            res.raised++
        }
        for (const r of db.prepare("SELECT * FROM RsiFinding WHERE domain = ? AND subject = ? AND status = 'open'").all(domain, subject)) {
            if (seen.has(r.code)) continue
            db.prepare("UPDATE RsiFinding SET status='resolved', state='remeasured', fixedAt=?, lastSeenAt=?, nextAction='Passes the gate: nothing to do' WHERE id=?").run(t, t, r.id)
            res.closed++
        }
        db.exec('COMMIT')
    } catch (e) { db.exec('ROLLBACK'); throw e }
    return res
}

/** Exit-code contract of a job script (documented on the Jobs page): 0 ok, 1 the gate found regressions, anything else infrastructure. */
export const EXIT_MEANING = { 0: 'ok: every check passed', 1: 'findings: the job ran and the gate found regressions (RSI findings are opened)', 2: 'failed: infrastructure (box, import, no result)' }
export const statusForExit = (code) => (code === 0 ? 'ok' : code === 1 ? 'findings' : 'failed')
