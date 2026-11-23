export const MIGRATION: string
export function migrationStatements(file?: string): string[]
export type BootstrapPlan = { username: string; hash: string; password: string; source: 'legacy' | 'env' | 'generated'; ingestOpen: boolean }
export function bootstrapPlan(input?: { settings?: Record<string, string | null | undefined>; env?: Record<string, string | undefined>; hasData?: boolean }): BootstrapPlan
