export function idParts(id: string): string[]
export function isMapPiece(pack: string, id: string): boolean
export const PIECE_SQL: string
export const PART_SQL: string
export type NameRules = { noise?: string[]; generic?: string[]; stripPrefix?: string; hideSegment?: string; labelStrip?: string; partPatterns?: string[]; piecePacks?: string; pieceDirs?: string[] }
export const NAME_DEFAULTS: Readonly<Required<NameRules>>
export function validateNameRules(input: string | NameRules): string
export function setNameRules(input: string | NameRules): void
export function loadNameRulesAsync(read: () => Promise<string | null>, ttlMs?: number): Promise<void>
export function describe(pack: string, id: string): { name: string; group: string; groupKey: string; piece: boolean }
export function placeOf(pack: string, id: string): { type: 'map' | 'library'; key: string; label: string } | null

