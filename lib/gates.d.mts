export const GATE_DOMAINS: Record<string, string>
export const REBASELINE_POLICY: string
export const EXIT_MEANING: Record<number, string>
export function statusForExit(code: number): 'ok' | 'findings' | 'failed'
