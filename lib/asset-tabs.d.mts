export const TAB_SQL: Record<'entities' | 'avatars' | 'models' | 'textures' | 'animations' | 'sounds', string>
export const DEDUPE_KEY: string
export const UNIQUE: string
export function packIn(packs: string[] | null): string
export function uniqueFor(packs: string[] | null): string
export function listCountSql(tab: string, kind?: string): string
export function aggCountSql(packs?: string[] | null): string
export function effectiveFilters(f: Record<string, string>): Record<string, string>
export function kindInTab(tab: string, kind: string): boolean
