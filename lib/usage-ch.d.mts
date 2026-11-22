export type ChConfig = { enabled: boolean; url: string; db: string; user: string; passwordEnv: string; password: string; batch: number }
export const CH_TABLES: string[]
export function chConfig(get: (k: string) => string | null | undefined, env?: Record<string, string | undefined>): ChConfig
export function publicConfig(c: ChConfig): { enabled: boolean; url: string; db: string; user: string; passwordEnv: string; passwordSet: boolean }
export function chQuery(c: ChConfig, sql: string, opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<Record<string, any>[]>
export function chPing(c: ChConfig, opts?: { fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<boolean>
