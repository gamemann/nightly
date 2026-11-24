export const GENERAL_DEFAULT: string[]
export const rules: Record<string, any>
export const compiled: Record<string, any>
export function setRules(input: unknown): void
export function loadRules(db: { prepare(sql: string): { get(...a: unknown[]): unknown } }): void
export function loadRulesAsync(read: () => Promise<string | null>, ttlMs?: number): Promise<void>
export function validateRules(input: unknown): string
export const REPO_CLASSES_DEFAULT: [string, string, string][]
