export function foldedFromReport(j: unknown): string
export function hitchesFromReport(j: unknown, top?: number): { t: number; ms: number }[]
export function flameSvg(text: string, o?: { width?: number; row?: number; title?: string; minPx?: number }): string
export function diffFlameSvg(a: string, b: string, o?: { width?: number; row?: number; title?: string; noisePct?: number; minPx?: number }): string
export function diffRows(a: string, b: string, o?: { top?: number }): { path: string; a: number; b: number; delta: number }[]
export function sparklineSvg(values: number[], o?: { width?: number; height?: number; budget?: number; color?: string }): string
export function hitchSvg(h: { t: number; ms: number }[], o?: { width?: number; height?: number; budgetMs?: number; title?: string }): string
export function reportMarkdown(o: any): string
export function reportSvg(o: any, p?: { width?: number }): string
export function bestFolded(o?: { stacks?: string; report?: string; funcs?: { name: string; path?: string; per?: string; selfMs: number }[] }): string
