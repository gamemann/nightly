export const EXIT: { pass: 0; fail: 1; error: 2 }
export type Gate = { pass: boolean; exit: number; game: string; run: { id: number; commit: string; platform: string; role: string; map: string; bots: number; ranAt: string }; failures: string[]; breaches: { metric: string; value: number; limit: number; op: string; over: number }[]; regressions: { metric: string; value: number; baseline: number; allowance: number; delta: number; pct: number; n: number }[]; improvements: Gate['regressions']; baselineRuns: number[]; skipped: string[] }
export function findRun(db: unknown, game: string, ref?: string, scope?: Record<string, unknown>): { id: number } | null
export function gate(db: unknown, slug: string, runId: number, o?: { budgets?: boolean; baseline?: boolean; noisePct?: number; sigma?: number; minRuns?: number; runs?: number; metrics?: string[] }): Gate
export function gateText(g: Gate): string
export function runFolded(db: unknown, run: { id: number; artefact: string }): string
export function runHitches(run: { artefact: string }): { t: number; ms: number }[]
export function findingRuns(db: unknown, f: { runId?: number | null; remeasuredRunId?: number | null }): { before: any; after: any } | null
export function runReport(db: unknown, runId: number, o?: { gate?: boolean; links?: { image?: string } }): { markdown: string; svg: string; gate: Gate | null }
export function svgToPng(svg: string, file: string): string
