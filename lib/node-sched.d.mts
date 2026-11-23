export const hasGpu: (specs: { gpu?: string[] } | null | undefined) => boolean
export const needsGpu: (kinds: string[], o?: { gpu?: boolean }) => boolean
export function detectHeavy(command: string, explicit?: boolean): { heavy: boolean; reason: string }
export function inferKinds(command: string): string[]
export type SchedNode = { id: number; name: string; type: string; online: boolean; enabled?: boolean; specs: { offloadKinds?: string[]; buildSlots?: number; heavySlots?: number; gpu?: string[] } | null; live?: { slots?: { build?: { used: number; max: number }; heavy?: { used: number; max: number } } } | null; reserved?: { build?: number; heavy?: number } }
export function pickNode(nodes: SchedNode[], job: { kinds?: string[]; heavy?: boolean; gpu?: boolean }, o?: { planetFallback?: boolean }): { node: SchedNode | null; capable: SchedNode[]; why: string }
