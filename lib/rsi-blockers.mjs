// Blocker minimisation for the RSI board: open items that are stale, duplicated or blocked become `process` findings with the reason
// and the next action. Stale and duplicate items that did not come from the owner are closed (wontfix, with a note). Nothing is
// ever "waiting on the owner" except the prod website deploy: an owner wait on any other item is itself a finding.
import * as S from './store.mjs'
import { OWNER } from './owner.mjs'

export const OWNER_WAIT = /waiting (on|for) (the )?(owner|christian)|owner (approval|to decide|must decide)|needs? (the )?owner/i
export const PROD_DEPLOY = /prod(uction)? (website )?deploy|owner deploy|OWNER DEPLOY/i
const norm = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const day = 86_400_000

/** Pure detection over item rows ({key,title,status,kind,addedBy,updatedAt,body,lastNote}). Returns [{subject, code, severity, msg, nextAction, close?}]. */
export function detect(items, { staleDays = 30, at = Date.now() } = {}) {
    const out = []
    const open = items.filter((i) => ['queue', 'blocked', 'in_progress', 'review'].includes(i.status) && i.kind !== 'check')
    const first = new Map()
    for (const i of [...open].sort((a, b) => a.id - b.id)) {
        const n = norm(i.title)
        if (first.has(n)) {
            const orig = first.get(n)
            out.push({ subject: i.key, code: 'DUPLICATE', severity: 'warn', msg: `same title as ${orig.key}`, nextAction: `Close ${i.key} as a duplicate of ${orig.key}`, close: i.addedBy !== OWNER ? `Duplicate of ${orig.key}` : null })
        } else first.set(n, i)
    }
    for (const i of open) {
        const age = (at - Date.parse(i.updatedAt)) / day
        if (staleDays && i.status !== 'in_progress' && age > staleDays && !out.some((o) => o.subject === i.key)) {
            out.push({ subject: i.key, code: 'STALE', severity: 'warn', msg: `untouched for ${Math.floor(age)} days`,
                nextAction: i.addedBy !== OWNER ? 'Auto-closed as stale; re-file if it still matters' : 'Re-queue with a fix agent now or close it as wontfix', close: i.addedBy !== OWNER ? `Untouched for ${Math.floor(age)} days` : null })
        }
        const text = `${i.body ?? ''}\n${i.lastNote ?? ''}`
        if (i.status === 'blocked' || OWNER_WAIT.test(text)) {
            const owner = OWNER_WAIT.test(text) && !PROD_DEPLOY.test(text) && !PROD_DEPLOY.test(i.title)
            out.push({ subject: i.key, code: owner ? 'OWNER_WAIT' : 'BLOCKED', severity: owner ? 'error' : 'warn',
                msg: (i.lastNote || i.body || 'blocked, no reason noted').trim().split('\n')[0].slice(0, 160),
                nextAction: owner ? 'Pick the safe default and proceed (agents decide); only the prod website deploy waits on the owner'
                    : i.status === 'blocked' ? 'Name the blocker in a note, queue a task that removes it, or retry on another box' : 'Proceed' })
        }
    }
    return out
}

/** Write the detections as `process` findings (resolving ones that cleared) and close the auto-closable items. */
export function syncBlockers(db, { staleDays = Number(S.getSetting(db, 'rsiStaleDays') ?? 30), at = Date.now() } = {}) {
    const items = db.prepare("SELECT id, key, title, body, kind, status, addedBy, updatedAt, (SELECT body FROM Note WHERE itemId = Item.id ORDER BY id DESC LIMIT 1) AS lastNote FROM Item WHERE status IN ('queue','blocked','in_progress','review')").all()
    const found = detect(items, { staleDays, at })
    const t = new Date(at).toISOString()
    const live = new Set(), res = { found: found.length, closed: 0 }
    for (const f of found) {
        const closing = f.close && S.getItem(db, f.subject)
        if (closing) {
            S.updateItem(db, f.subject, { status: 'wontfix' })
            S.addNote(db, f.subject, `Auto-closed by the RSI board (${f.code}): ${f.close}.`)
            res.closed++
        }
        live.add(`${f.subject}|${f.code}`)
        const old = db.prepare("SELECT id FROM RsiFinding WHERE subject = ? AND code = ? AND tier = ''").get(f.subject, f.code)
        const state = closing ? 'remeasured' : 'found', status = closing ? 'resolved' : 'open'
        if (old) db.prepare('UPDATE RsiFinding SET severity=?, msg=?, nextAction=?, state=?, status=?, lastSeenAt=?, fixedAt=? WHERE id=?').run(f.severity, f.msg, f.nextAction, state, status, t, closing ? t : null, old.id)
        else db.prepare('INSERT INTO RsiFinding (domain, subject, code, severity, msg, nextAction, state, status, itemKey, firstSeenAt, lastSeenAt, fixedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('process', f.subject, f.code, f.severity, f.msg, f.nextAction, state, status, f.subject, t, t, closing ? t : null)
    }
    for (const r of db.prepare("SELECT id, subject, code FROM RsiFinding WHERE domain = 'process' AND status = 'open' AND code IN ('STALE','DUPLICATE','BLOCKED','OWNER_WAIT')").all()) {
        if (!live.has(`${r.subject}|${r.code}`)) db.prepare("UPDATE RsiFinding SET status='resolved', state='remeasured', fixedAt=? WHERE id=?").run(t, r.id)
    }
    // asset findings whose fix item is done but not yet re-audited: state fixed
    db.prepare("UPDATE RsiFinding SET state='fixed', nextAction='Fix item is done: remeasure with nightly assets refresh' WHERE status='open' AND domain != 'process' AND state='found' AND itemKey != '' AND EXISTS (SELECT 1 FROM Item i WHERE i.key = RsiFinding.itemKey AND i.status = 'done' AND i.completedAt > RsiFinding.lastSeenAt)").run()
    return res
}
