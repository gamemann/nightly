export const NODE_TYPES: ('planet' | 'station')[]
export const OFFLOAD_KINDS: string[]
export const LINK_AUTH: string[]
export const DB_KINDS: string[]
export type NodeSpecs = {
    cpu?: { model: string; mhz: number; cores: number; threads: number }
    ram?: { gb: number; type: string; mhz: number }
    gpu?: string[]
    disks?: { name: string; gb: number; ssd: boolean; model: string }[]
    buildSlots?: number; heavySlots?: number; offloadKinds?: string[]; os?: string
    [k: string]: unknown
}
export function probeLocal(): NodeSpecs
export function parseSshConfig(text: string): Record<string, { hostname?: string; user?: string; port?: number; identityFile?: string }>
export function checkSpecs(specs: string | NodeSpecs | null | undefined): NodeSpecs
