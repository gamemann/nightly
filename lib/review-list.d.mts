type Counts = { total: number; good: number; wrong: number; todo: number }
export type ReviewRow = { key: string; title: string; game: string; counts: Counts; createdAt: string; updatedAt: string }
export const REVIEW_SORTS: string[]
export function filterWeapons<T extends { id: string; w: { title?: string; verdict?: string } }>(rows: T[], o?: { q?: string; verdict?: string; dir?: 'asc' | 'desc' }): T[]
export function filterReviews<T extends ReviewRow>(all: T[], o?: { q?: string; game?: string; state?: string; sort?: string; dir?: 'asc' | 'desc' }): T[]
