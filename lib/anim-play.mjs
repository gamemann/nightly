// Pure helpers for the asset viewer's clip playback (client-safe: no node:* imports).

/** A clip can be played when it has a positive duration; zero-length (static pose) clips cannot. */
export const clipPlayable = (length) => typeof length === 'number' && Number.isFinite(length) && length > 0

/** The clip to show first: an idle-like clip when the model has one, else the first playable clip, else ''. */
export function defaultClip(clips) {
    const ok = clips.filter((c) => clipPlayable(c.length))
    return (ok.find((c) => /idle/i.test(c.name)) ?? ok[0])?.name ?? ''
}

/** Step the playhead by dt seconds at `rate`. Looping wraps; otherwise it stops at the end (ended = true). */
export function advance(t, dt, rate, length, loop) {
    if (!clipPlayable(length)) return { t: 0, ended: false }
    const n = t + dt * rate
    if (n >= length) return loop ? { t: n % length, ended: false } : { t: length, ended: true }
    if (n < 0) return loop ? { t: ((n % length) + length) % length, ended: false } : { t: 0, ended: false }
    return { t: n, ended: false }
}

export const RATES = [0.25, 0.5, 1, 1.5, 2]
