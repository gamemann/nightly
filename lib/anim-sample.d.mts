export const PER_FRAME: Record<string, number>
export function frameAt(t: number, frames: number, fps: number, loop: boolean): { a: number; b: number; k: number }
export function sample(track: { path: string; values: number[] }, t: number, frames: number, fps: number, loop: boolean): number[]
export const verticalFrom43: (h: number) => number
export function lens(lensInfo: { reference_depth: number; max_pull_in: number; depth_comp: number }, camV: number, handsV: number): { k: number; z: number }
export const deg: (r: number) => number
export const rad: (d: number) => number
export function moveShare(lensInfo: { reference_depth: number; max_pull_in: number; depth_comp: number; reference_fov?: number }, handsV: number): number
