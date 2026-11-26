export const NODE_PARTS: string[]
export function partPose(clip: { frames: number; loop: boolean; tracks: { target: string; path: string; values: number[] }[] }, part: string, t: number, fps: number): { pos: number[] | null; quat: number[] | null; visible: boolean | null } | null
export function animatedParts(side: { nodes?: Record<string, string>; clips: { tracks: { target: string }[] }[] }): { part: string; node: string }[]
