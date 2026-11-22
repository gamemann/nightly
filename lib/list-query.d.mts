type Dir = 'asc' | 'desc'
export const RUN_SORTS: string[]
export const PROMPT_SORTS: string[]
export function runsQuery(o: { game: string; platform?: string; role?: string; map?: string; bots?: number; q?: string; sort?: string; dir?: Dir }): { where: Record<string, unknown>; orderBy: Record<string, Dir>[] }
export function promptsQuery(o: { kind: string; q?: string; sort?: string; dir?: Dir }): { where: Record<string, unknown>; orderBy: Record<string, Dir>[] }
