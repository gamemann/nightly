export type Dim = 'model' | 'texture' | 'sound' | 'anim' | 'icon' | 'licence'
export type Status = 'ok' | 'placeholder' | 'stale' | 'missing' | 'na'
export type RowCoverage = { s: Record<Dim, Status>; o: '' | 'no-source' | 'disabled' | 'root-missing'; g: Dim[]; l?: string }
export type DimCounts = Record<Dim, Record<Status, number>>
export type KindCoverage = { kind: string; rows: number; complete: number; gaps: Record<Dim, number>; dims: DimCounts }
export type PackCoverage = { pack: string; rows: number; complete: number; orphan: string; kinds: KindCoverage[] }
export type Matrix = { totals: { rows: number; complete: number; orphan: number; dims: DimCounts }; packs: PackCoverage[] }
export const DIMS: Dim[]
export const STATUSES: Status[]
export const NO_LICENCE: RegExp
export function needsOf(budget?: Record<string, unknown>): Dim[]
export function stemsOf(row: { weaponId?: string }, data: unknown): string[]
export function licenceOf(rel: string, idx?: { rules?: { match: string; licence: string }[]; entries?: { paths?: string[]; licence: string }[] }): string
export function coverageOf(row: Record<string, unknown>, data: unknown, opts: { needs: Dim[]; idx?: unknown; exists?: (p: string) => boolean }): RowCoverage
export function aggregate(rows: { pack: string; kind: string; coverage: string | RowCoverage | null }[]): Matrix
export function refresh(db: unknown, opts?: { only?: string[]; exists?: (p: string) => boolean }): Matrix
export function emptySources(db: unknown): { name: string; enabled: boolean; rootOk: boolean }[]
export function text(m: Matrix, empty?: { name: string; enabled: boolean; rootOk: boolean }[]): string
