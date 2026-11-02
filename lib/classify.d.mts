export const OTHER: string
export const DEV: string
export const BACKBONE: string
export function gameFromText(key: string, title: string): string
export function reposFromText(key: string, title: string): string[]
export function classify(repos: string, key: string, title: string, known: Set<string>): string
export function suggestRepos(key: string, title: string): string
export function isGame(name: string): boolean
