export const RENAMES: Record<string, string>
export const REPO_LIKE: RegExp
export function tokenName(t: string): string
export function tokensOf(repos: string): string[]
export function makeResolver(projects: { slug: string; type?: string; repoPath?: string; settings?: unknown }[], opts?: { renames?: Record<string, string> }): {
    resolveToken(token: string): { slug: string; via: string } | { general: true } | null
    resolveItem(repos: string, key?: string, title?: string): { links: { slug: string; via: string; token: string }[]; unresolved: string[]; general: boolean }
    resolvePack(pack: string): { slug: string; role: string; via: string }[]
    slugs: Set<string>
}
export function countSqls(ids: number[], grouped: boolean): { tasks: string; assets: string }
