export type Backend = { dialect: 'sqlite' | 'ch'; db?: string; q(sql: string): Promise<Record<string, any>[]> }
export type Tally = { input: number; output: number; cache_read: number; cache_5m: number; cache_1h: number; thinking: number }
export type Prices = Record<string, { input: number; output: number; cache_read: number; cache_5m: number; cache_1h: number }>
export type Totals = Tally & { total: number; messages: number; cost: number }
export type Row = Tally & { key: string; total: number; messages: number; cost: number; share: number; costShare: number; first: number; last: number }
export type ToolRow = { key: string; calls: number; total: number; biggest: number; errors: number; share: number }
export type Insight = { id: string; level: 'warn' | 'info'; title: string; detail: string; suggestion: string; tokens?: number; cost?: number }
export type SessionRow = Tally & { key: string; project: string; branch: string; total: number; messages: number; subMessages: number; cost: number; first: number; last: number; compactions: number }
export const DIMS: Record<string, string>
export function totals(be: Backend, prices: Prices, now?: number): Promise<Record<'today' | '7d' | '30d' | 'all', Totals>>
export function series(be: Backend, prices: Prices, o?: { unit?: 'day' | 'hour'; since?: number; until?: number }): Promise<{ unit: string; buckets: { t: string; byKind: Record<string, number>; byModel: Record<string, number>; cost: number }[] }>
export function breakdown(be: Backend, prices: Prices, dim: string, o?: { since?: number; filter?: Record<string, string> }): Promise<{ dim: string; estimated?: boolean; total: number; cost?: number; rows: any[] }>
export function sessions(be: Backend, prices: Prices, o?: { since?: number; filter?: Record<string, string>; limit?: number }): Promise<SessionRow[]>
export function insights(be: Backend, prices: Prices, o?: { since?: number; pollMin?: number; bigResultTokens?: number }): Promise<Insight[]>
export function foldRuns(rows: { startedAt: string | Date; minutes?: number | null; turns?: number | null; costUsd?: number | null }[]): { total: { runs: number; turns: number; minutes: number; costUsd: number }; byDay: { day: string; runs: number; turns: number; minutes: number; costUsd: number }[] }
