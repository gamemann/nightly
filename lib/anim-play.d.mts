export type ClipInfo = { name: string; length: number }
export function clipPlayable(length: unknown): boolean
export function defaultClip(clips: ClipInfo[]): string
export function advance(t: number, dt: number, rate: number, length: number, loop: boolean): { t: number; ended: boolean }
export const RATES: number[]
