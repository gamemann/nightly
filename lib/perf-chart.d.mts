// Loose typing: the module is plain JS shared with node --test.
/* eslint-disable @typescript-eslint/no-explicit-any */
export const SECTIONS: { id: string; title: string; blurb: string; metrics: string[] }[]
export const FRAME_PERCENTILES: string[]
export const INFO: Record<string, { title: string; desc: string; good: string; unit?: string }>
export const PALETTE: Record<string, string>
export type Pt = { i: number; id: number; t: number; ranAt: string | Date; commit: string; build: string; label: string; platform: string; role: string; map: string; bots: number; value: number }
export type Delta = { delta: number | null; pct: number | null; good: boolean | null; prevId: number | null; budget: { limit: number; kind: 'max' | 'min'; over: number; pct: number | null; ok: boolean } | null }
export type Reason = { index: number; id: number; value: number; baseline: number; pct: number; budgetBreach: boolean; reason: string }
export type RunRow = { id: number; ranAt: string | Date; commit: string; build: string; label: string; platform: string; role: string; map: string; bots: number; metrics: Record<string, number> }
export type Summary = { metric: string; latest: number; id: number; count: number; delta: number | null; pct: number | null; good: boolean | null; budget: Delta['budget']; trend: { dir: 'better' | 'worse' | 'flat'; pct: number; enough: boolean }; spark: number[]; reasons: Reason[] }
export function infoOf(m: string): { title: string; desc: string; good: string; unit?: string }
export function sectionOf(m: string): string
export function colorOf(m: string): string
export function fmt(v: number | null | undefined, unit?: string): string
export function fmtPct(p: number | null | undefined): string
export function budgetsFor(budgets: any[], metric: string, scope?: any): any[]
export function limitOf(b: any): number
export function seriesOf(runs: RunRow[], metric: string): Pt[]
export function movingAverage(values: number[], n: number): number[]
export function improved(metric: string, a: number, b: number): boolean
export function pointDeltas(points: Pt[], metric: string, budgets?: any[]): Delta[]
export function regressionReasons(points: Pt[], metric: string, budgets?: any[], opts?: { window?: number; noisePct?: number }): Reason[]
export function yDomain(values: number[], opts?: { log?: boolean }): { lo: number; hi: number; log: boolean }
export function niceTicks(lo: number, hi: number, n?: number): number[]
export function logTicks(lo: number, hi: number): number[]
export function timeTicks(t0: number, t1: number, n?: number): { t: number; label: string }[]
export function dateLabel(t: number, span?: number): string
export function dateFull(t: number): string
export function nearest(points: { t: number }[], t: number): number
export function trendOf(metric: string, values: number[], opts?: { n?: number; floorPct?: number }): Summary['trend']
export function lowData(points: Pt[]): string | null
export function summarise(runs: RunRow[], metric: string, budgets?: any[]): Summary | null
export function statusCards(runs: RunRow[], metrics: string[], budgets?: any[], opts?: { recent?: number }): { sums: Summary[]; budgets: { checked: number; failing: string[]; pass: boolean }; fps: Summary | null; worst: { metric: string; pct: number; reason: string } | null; regressions: number; regressionRuns: number }
export function heatmap(runs: RunRow[], metrics: string[], opts?: { window?: number; noisePct?: number; last?: number }): { runs: RunRow[]; rows: { metric: string; cells: { id: number; z: number | null; value: number | null; base?: number; flag: boolean }[] }[] }
export function histogram(values: number[], bins?: number): { bins: { lo: number; hi: number; n: number }[]; max: number }
export function diffRuns(a: RunRow, b: RunRow, budgets?: any[], opts?: { noisePct?: number }): { metric: string; a?: number; b?: number; delta: number | null; pct: number | null; verdict: 'same' | 'better' | 'worse' | 'new' | 'gone'; budget: { limit: number; kind: string; ok: boolean } | null }[]
export function worstMetrics(cards: ReturnType<typeof statusCards>, top?: number): { metric: string; score: number; value: number; budget: Delta['budget']; reason: string }[]
