export type LocLanguage = { name: string; files: number; code: number; comments: number; blanks: number }
export type LocTotals = { code: number; comments: number; blanks: number; total: number; files: number }
export type LocStats = LocTotals & { byLanguage: LocLanguage[] }
export const LOC_EXCLUDE_DIRS: string[]
export const LOC_NOT_MATCH: string
export function sccArgs(root: string): string[]
export function parseScc(text: string | unknown): LocStats
export function addStats(a: LocTotals, b: LocTotals): LocTotals
export function mergeLanguages(a: LocLanguage[], b: LocLanguage[]): LocLanguage[]
export function folderPath(folders: { id: number; parentId: number | null; name: string }[], id: number | null): string
export function rollup(folders: { id: number; parentId: number | null }[], projects: { id: number; folderId: number | null }[], stats: Map<number, LocStats>): Map<number, LocStats & { projects: number }>
export function utcDay(ms: number): string
export function decide(latest: { sha: string; scannedAt: number } | null, sha: string, opts?: { force?: boolean; now?: number; staleMs?: number }): 'scan' | 'snapshot' | 'skip'
export function historyRow(ts: number, k: { project?: string; folderPath?: string; type: 'project' | 'folder' }, s: LocTotals, sha?: string): Record<string, string | number>
export function historyRows(ts: number, changed: { slug: string; folderId: number | null; stats: LocTotals; sha: string }[], folders: { id: number; parentId: number | null; name: string }[], rolled: Map<number, LocTotals>): Record<string, string | number>[]
export function compact(n: number): string
