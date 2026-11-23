export function idParts(id: string): string[]
export function isMapPiece(pack: string, id: string): boolean
export const PIECE_SQL: string
export function describe(pack: string, id: string): { name: string; group: string; groupKey: string; piece: boolean }
export function placeOf(pack: string, id: string): { type: 'map' | 'library'; key: string; label: string } | null

export const ENTITY_KINDS: string[]
