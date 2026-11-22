export const CAT: string[]
export const COLOR: { bad: string; info: string; warn: string; good: string; none: string; seq: string }
export const RUN_STATES: { key: string; label: string; color: string }[]
export function stateOf(status: string): string
export function dayStart(t: number | string | Date): number
export function dayKey(t: number | string | Date): string
export type DayBucket = { key: string; t: number; total: number; segments: Record<string, number>; ids: number[] }
export function statusByDay(runs: { id: number; startedAt: Date | string; status: string }[], o?: { days?: number; now?: number }): DayBucket[]
export function successRate(runs: { status: string }[]): number | null
export function runSeries(runs: { id: number; startedAt: Date | string; [k: string]: unknown }[], field: string, o?: { last?: number }): { id: number; t: number; v: number }[]
export function startHeat(times: (Date | string | number)[], o?: { offsetMin?: number }): { grid: number[][]; max: number; total: number }
export type ScheduleRow = { id: number | null; name: string; total: number; rate: number | null; roll: number[]; strip: { id: number; state: string }[]; medianMinutes: number | null }
export function perSchedule(runs: { id: number; startedAt: Date | string; status: string; minutes: number | null; schedule: { id: number; name: string } | null }[], o?: { last?: number }): ScheduleRow[]
export type Fire = { scheduleId: number; name: string; at: Date | string | number }
export function timelineOf(fires: Fire[], o?: { now?: number; hours?: number }): (Fire & { t: number; inHours: number })[]
export function scoreBins(rows: { score: number }[], o?: { width?: number }): { lo: number; hi: number; label: string; count: number; tier: "fail" | "warn" | "pass" }[]
export function passByGroup<T extends { score: number; pass: boolean }>(rows: T[], by: (r: T) => string | string[] | null | undefined): { key: string; total: number; pass: number; rate: number; mean: number }[]
export function flagCounts(rows: { flags?: { code: string; severity: string; tab: string }[] }[], tab?: string): { code: string; severity: string; n: number }[]
export function worstOffenders<T extends { score: number; weaponId: string }>(rows: T[], n?: number): T[]
export function qaTrend(runs: { id: number; ranAt: Date | string; ok: boolean }[], o?: { days?: number; now?: number }): { key: string; t: number; total: number; pass: number; fail: number; ids: number[] }[]
export type QaCell = { key: string; total: number; pass: number; rate: number | null; id?: number }
export function qaAreaGrid(runs: { id: number; game: string; kind: string; ranAt: Date | string; ok: boolean }[], o?: { days?: number; now?: number }): { cols: string[]; rows: { key: string; game: string; kind: string; cells: QaCell[] }[] }
export type VerdictCounts = { total: number; good: number; wrong: number; todo: number }
export function verdictParts(reviews: { counts: VerdictCounts }[]): { key: string; label: string; value: number }[]
export function reviewProgress(reviews: { key: string; title: string; game: string; counts: VerdictCounts }[]): { key: string; title: string; game: string; total: number; good: number; wrong: number; todo: number; judged: number }[]
export function verdictsByDay(reviews: { weapons?: Record<string, { verdict?: string; at?: string; history?: { verdict: string; at: string }[] }> }[], o?: { days?: number; now?: number }): { key: string; t: number; good: number; wrong: number }[]
export const fmtMinutes: (m: number | null | undefined) => string
export const fmtUsd: (c: number | null | undefined) => string
