export type ProjectType = 'website' | 'game' | 'game-addon'
export const PROJECT_TYPES: ProjectType[]
export const SLUG: RegExp
export function checkSlug(s: string): string
export function checkType(t: string): ProjectType
export const SEED_FOLDERS: string[][]
export function classifyRepo(name: string, kind?: 'name' | 'godot' | 'web' | 'none', siblings?: Set<string>): { slug: string; type: ProjectType; folder: string[] } | null
export function projectName(slug: string, type: ProjectType | string): string
export function parseSettings(s: string | null | undefined): Record<string, unknown>
