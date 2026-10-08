export const KINDS = ['task', 'issue', 'check', 'study'] as const
export const STATUSES = ['queue', 'in_progress', 'review', 'blocked', 'done', 'wontfix'] as const
export const OPEN_STATUSES = ['in_progress', 'review', 'queue', 'blocked'] as const
export const CADENCES = ['nightly', 'every-2-days', 'weekly', 'monthly'] as const
export const AUTHORS = ['christian', 'nightly', 'session'] as const
// Keep in step with lib/store.mjs (the CLI's copy).
export const CADENCE_HOURS: Record<string, number> = { nightly: 20, 'every-2-days': 44, weekly: 6.5 * 24, monthly: 28 * 24 }

// The agent board's liveness window. Keep in step with lib/agents.mjs.
export const LIVE_MINUTES = 60

export type Kind = (typeof KINDS)[number]
export type Status = (typeof STATUSES)[number]

export const STATUS_LABEL: Record<string, string> = {
    queue: 'Queue', in_progress: 'In progress', review: 'Review', blocked: 'Blocked', done: 'Done', wontfix: "Won't fix",
}

export function isDue(it: { kind: string; status: string; cadence: string | null; lastRunAt: Date | null }, at = Date.now()) {
    if (it.kind !== 'check' || !(OPEN_STATUSES as readonly string[]).includes(it.status)) return false
    if (!it.lastRunAt) return true
    return at - it.lastRunAt.getTime() >= (CADENCE_HOURS[it.cadence ?? 'nightly'] ?? 20) * 3600_000
}

const STOP = new Set('a an the and or of to in on for is are its it with by at be no not from that this still does do'.split(' '))
export function slugify(title: string) {
    const words = title.toLowerCase().replace(/`/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((w) => w && !STOP.has(w))
    let s = ''
    for (const w of words) {
        if (s && (s + '-' + w).length > 20) break
        s = s ? `${s}-${w}` : w
    }
    return s.slice(0, 20) || 'item'
}
