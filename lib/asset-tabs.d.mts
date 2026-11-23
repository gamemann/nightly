export const TAB_SQL: Record<'entities' | 'models' | 'textures' | 'animations' | 'sounds', string>
export const DEDUPE_KEY: string
export const UNIQUE: string
export function listCountSql(tab: string, kind?: string): string
export function aggCountSql(): string
export function effectiveFilters(f: Record<string, string>): Record<string, string>
