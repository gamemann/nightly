export const COLS: [string, string][]
export const INDEXES: string[]
export const BACKFILL: string
export function alterStatements(existing: Set<string>): string[]
export function shapeOf(rec: unknown, files: unknown): Record<string, number | string>
export function ensureColumns(db: unknown): number
