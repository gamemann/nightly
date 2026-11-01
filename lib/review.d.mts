export type ReviewMedia = { slot: string; variant: string; label: string; file: string; licence: string; source: string; note: string; by: string; at: string; waveform?: string; url?: string; look?: string; metrics?: Record<string, string | number | boolean> | null; poster?: string; strip?: string; duration?: number; width?: number; height?: number; fps?: number }
export type ReviewWeapon = { title: string; look?: string; metrics?: Record<string, string | number | boolean>; media: ReviewMedia[]; verdict: string; note: string; by: string; at: string; history: { verdict: string; note: string; by: string; at: string }[] }
export const REVIEW_DIR: string
export const TYPES: Record<string, string>
export function load(key: string): { weapons: Record<string, ReviewWeapon> }
export function addMedia(key: string, weaponId: string, src: string, o: { slot: string; variant?: string; label?: string; licence?: string; source?: string; note?: string; title?: string; waveform?: string; by?: string; look?: string; metrics?: unknown; entryLook?: string; entryMetrics?: unknown }): ReviewMedia
export function setVerdict(key: string, weaponId: string, verdict: string, o?: { note?: string; by?: string }): { weapon: string; verdict: string; note: string; by: string; at: string }
export function mediaPath(key: string, parts: string[]): string | null
export function open(key: string): { weapon: string; title: string; verdict: string; note: string }[]
export function urlFor(key: string, file: string): string
