export type Budget = { metric: string; max?: number; min?: number; platform?: string; role?: string; map?: string; bots?: number }
export type MetricRow = { metric: string; a?: number; b?: number; delta?: number; pct?: number; verdict: 'same' | 'better' | 'worse' | 'new' | 'gone' }
export type FuncRow = { name: string; path: string; per: string; grp: string; addon: string; selfMs: number; totalMs: number; calls: number }
export const PLATFORMS: string[]
export const ROLES: string[]
export const METRICS: Record<string, { unit: string; better?: 'higher' | 'lower' }>
export function betterOf(metric: string): 'higher' | 'lower'
export function unitOf(metric: string): string
export function parseFolded(text: string): { stack: string; value: number }[]
export function budgetSpec(b: Budget): string
export function evaluateBudgets(budgets: Budget[], run: { platform: string; role: string; map?: string; bots?: number }, metrics: Record<string, number>): { breaches: (Budget & { value: number; limit: number; op: 'max' | 'min'; over: number })[]; checked: Budget[] }
export function compareMetrics(a: Record<string, number>, b: Record<string, number>, o?: { noisePct?: number }): MetricRow[]
export function compareFunctions(a: FuncRow[], b: FuncRow[], o?: { noisePct?: number; minAbs?: number }): { name: string; a?: number; b?: number; delta: number; pct: number; verdict: string; addon: string; grp: string }[]
export function regressionMarkers(series: { value: number }[], metric: string, o?: { window?: number; noisePct?: number }): number[]
