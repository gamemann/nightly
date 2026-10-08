// Five-field cron expressions (minute hour day-of-month month day-of-week), in the box's
// local time, which is what crontab uses. Shared by the CLI (`nightly tick`) and the panel
// (validation, next fire times). Supports *, lists, ranges, steps, month and weekday
// names, and @hourly/@daily/@weekly/@monthly. As in cron, when both day fields are
// restricted a day matches either one.

const FIELDS = [
    { name: 'minute', min: 0, max: 59 },
    { name: 'hour', min: 0, max: 23 },
    { name: 'day of month', min: 1, max: 31 },
    { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'], base: 1 },
    { name: 'day of week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'], base: 0 },
]
const ALIASES = { '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0', '@monthly': '0 0 1 * *' }

function num(s, f) {
    const i = f.names?.indexOf(s.toLowerCase()) ?? -1
    if (i !== -1) return i + f.base
    if (!/^\d+$/.test(s)) throw new Error(`bad ${f.name} "${s}"`)
    const n = Number(s)
    if (n < f.min || n > f.max) throw new Error(`${f.name} ${n} out of range ${f.min}-${f.max}`)
    return n
}

function field(src, f) {
    const set = new Set()
    for (const part of src.split(',')) {
        const [range, stepS] = part.split('/')
        const step = stepS === undefined ? 1 : Number(stepS)
        if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in ${f.name} "${part}"`)
        let lo, hi
        if (range === '*') [lo, hi] = [f.min, f.max]
        else if (range.includes('-')) [lo, hi] = range.split('-').map((x) => num(x, f))
        else [lo, hi] = [num(range, f), stepS === undefined ? num(range, f) : f.max]
        if (lo > hi) throw new Error(`bad range in ${f.name} "${part}"`)
        for (let v = lo; v <= hi; v += step) set.add(v)
    }
    return set
}

/** Parse an expression; throws an Error with a readable message when it is invalid. */
export function parseCron(expr) {
    const src = ALIASES[expr.trim().toLowerCase()] ?? expr.trim()
    const parts = src.split(/\s+/)
    if (parts.length !== 5) throw new Error('needs 5 fields: minute hour day-of-month month day-of-week')
    const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]))
    if (dow.has(7)) dow.add(0)
    return { minute, hour, dom, month, dow, domAny: parts[2] === '*', dowAny: parts[4] === '*' }
}

function dayMatches(c, d) {
    const a = c.dom.has(d.getDate())
    const b = c.dow.has(d.getDay())
    if (c.domAny && c.dowAny) return true
    if (c.domAny) return b
    if (c.dowAny) return a
    return a || b
}

/** Does `date` (to the minute) match? */
export function cronMatches(expr, date = new Date()) {
    const c = typeof expr === 'string' ? parseCron(expr) : expr
    return c.minute.has(date.getMinutes()) && c.hour.has(date.getHours()) && c.month.has(date.getMonth() + 1) && dayMatches(c, date)
}

/** The next `n` fire times strictly after `from`. Gives up after a year (e.g. "0 0 31 2 *"). */
export function nextFires(expr, from = new Date(), n = 1) {
    const c = typeof expr === 'string' ? parseCron(expr) : expr
    const out = []
    const d = new Date(from)
    d.setSeconds(0, 0)
    d.setMinutes(d.getMinutes() + 1)
    const end = from.getTime() + 366 * 86400_000
    while (out.length < n && d.getTime() <= end) {
        if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0); continue }
        if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0); continue }
        if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0); continue }
        if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue }
        out.push(new Date(d))
        d.setMinutes(d.getMinutes() + 1)
    }
    return out
}

/** null when valid, else the reason. */
export function cronError(expr) {
    try { parseCron(expr); return null } catch (e) { return e.message }
}
