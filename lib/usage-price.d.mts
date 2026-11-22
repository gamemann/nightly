export const KINDS: string[]
export const DEFAULT_PRICES: Record<string, { input: number; output: number; cache_read: number; cache_5m: number; cache_1h: number }>
export function parsePrices(text: string | null | undefined): Record<string, { input: number; output: number; cache_read: number; cache_5m: number; cache_1h: number }>
export function priceFor(prices: Record<string, any>, model: string): { input: number; output: number; cache_read: number; cache_5m: number; cache_1h: number }
export function cost(prices: Record<string, any>, model: string, tally: Partial<Record<string, number>>): number
