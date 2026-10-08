// Unsaved text kept in localStorage, so navigating away, a refetch, a crash or a closed tab costs nothing.
// `base` is the server value the draft was started from: if the server has moved on since, the editor can say so
// instead of silently overwriting whatever the nightly run (or another tab) wrote.
export type Draft = { text: string; base: string; at: number }

const PREFIX = 'nightly:draft:'

// Every access is guarded: storage throws in private windows and with site data blocked, and a draft is a
// convenience -- losing one must never break the editor.
export function readDraft(id: string): Draft | null {
    try {
        const raw = localStorage.getItem(PREFIX + id)
        if (!raw) return null
        const d = JSON.parse(raw) as Draft
        return typeof d?.text === 'string' ? d : null
    } catch {
        return null
    }
}

export function writeDraft(id: string, text: string, base: string) {
    try {
        if (text === base) localStorage.removeItem(PREFIX + id)
        else localStorage.setItem(PREFIX + id, JSON.stringify({ text, base, at: Date.now() } satisfies Draft))
    } catch {}
}

export function clearDraft(id: string) {
    try {
        localStorage.removeItem(PREFIX + id)
    } catch {}
}
