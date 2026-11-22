import type { PageSpec } from './paging'

/** The paging spec of each health feed (sortable columns, facet filters); the client parses the URL with it, the server whitelists with it. */
export const FEED_SPECS = {
    releases: { sorts: ['at', 'repo', 'version', 'channel', 'ci', 'deployedTo'], sort: 'at', dir: 'desc', filters: ['game', 'channel', 'ci'] },
    crashes: { sorts: ['count', 'game', 'signature', 'version', 'platform', 'status', 'at'], sort: 'count', dir: 'desc', filters: ['game', 'status', 'platform'] },
    playtests: { sorts: ['at', 'game', 'build', 'tester', 'rating'], sort: 'at', dir: 'desc', filters: ['game', 'tester'] },
    content: { sorts: ['game', 'category', 'name', 'metric', 'value'], sort: 'game', dir: 'asc', filters: ['game', 'category', 'metric'] },
    web: { sorts: ['key', 'latest', 'budget', 'at'], sort: 'key', dir: 'asc', filters: ['game', 'state'] },
} as const satisfies Record<string, PageSpec>
export type FeedName = keyof typeof FEED_SPECS

/** Performance tab tables (RSI loop and findings); the Perf page is scoped to one game or all of them. */
export const PERF_SPECS = {
    findings: { sorts: ['updatedAt', 'game', 'metric', 'status'], sort: 'updatedAt', dir: 'desc', filters: ['game', 'status'] },
    rsi: { sorts: ['updatedAt', 'game', 'kind', 'state', 'value'], sort: 'updatedAt', dir: 'desc', filters: ['game', 'state', 'kind'] },
} as const satisfies Record<string, PageSpec>
