import { can, type Perms } from '../../lib/permissions.mjs'

// The sidebar, as data. Each link names the permission(s) it needs (all of them); the sidebar
// hides what the viewer cannot open, and the pages check the same keys server-side (pageGuard).
// EXTENSION POINT: a later phase adds a link here and a page under src/app; nothing else.
export type NavLink = {
    href: string
    label: string
    /** A one-character glyph shown before the label (and alone when the sidebar is collapsed). */
    icon: string
    /** Every key listed must be granted. Omitted: any signed-in user. */
    perm?: string | string[]
    /** Extra path prefixes that mark this link active. */
    also?: string[]
    /** Tailwind class of a colored status dot instead of the glyph. */
    dot?: string
    /** item.counts key shown as a badge. */
    count?: 'queue' | 'in_progress' | 'review' | 'blocked' | 'issues' | 'checks' | 'done'
}
export type NavSection = { key: string; title?: string; href?: string; perm?: string | string[]; rule?: boolean; links: NavLink[] }

export const TASK_LINKS: NavLink[] = [
    { href: '/tasks/queue', label: 'Queue', icon: '•', dot: 'bg-sky-400', count: 'queue', perm: 'tasks.view' },
    { href: '/tasks/in-progress', label: 'In Progress', icon: '•', dot: 'bg-amber-400', count: 'in_progress', perm: 'tasks.view' },
    { href: '/tasks/review', label: 'Review', icon: '•', dot: 'bg-violet-400', count: 'review', perm: 'tasks.view' },
    { href: '/tasks/blocked', label: 'Blocked', icon: '•', dot: 'bg-red-400', count: 'blocked', perm: 'tasks.view' },
    { href: '/tasks/issues', label: 'Issues', icon: '•', dot: 'bg-rose-300', count: 'issues', perm: 'tasks.view' },
    { href: '/tasks/done', label: 'Done', icon: '•', dot: 'bg-emerald-400', count: 'done', perm: 'tasks.view' },
]

export const ADMIN_LINKS: NavLink[] = [
    { href: '/admin/schedules', label: 'Schedules', icon: '◷', perm: 'admin.schedules' },
    { href: '/admin/prompts', label: 'Prompts', icon: '¶', perm: 'admin.prompts' },
    { href: '/admin/jobs', label: 'Jobs & Scripts', icon: '▶', perm: 'admin.jobs' },
    { href: '/admin/runs', label: 'Runs & reports', icon: '▸', perm: 'admin.runs' },
    { href: '/admin/web', label: 'Web checks', icon: '◎', perm: 'admin.web' },
    { href: '/admin/crashlog', label: 'Crash Log', icon: '✖', perm: 'admin.crashlog' },
    { href: '/admin/settings', label: 'Settings', icon: '⚙', perm: 'admin.settings' },
    { href: '/admin/users', label: 'Users', icon: '☺', perm: 'admin.users' },
    { href: '/admin/roles', label: 'Roles', icon: '⚑', perm: 'admin.roles' },
    { href: '/admin/nodes', label: 'Nodes', icon: '◈', perm: 'admin.nodes' },
    { href: '/admin/communication', label: 'Communication', icon: '✉', perm: 'admin.comm' },
    { href: '/admin/databases', label: 'Databases', icon: '⛁', perm: 'admin.databases' },
    { href: '/admin/builds', label: 'Builds', icon: '⚒', perm: 'admin.builds' },
]

export const NAV: NavSection[] = [
    { key: 'projects', title: 'Projects', href: '/projects', links: [] },
    { key: 'tasks', title: 'Tasks', perm: 'tasks.view', links: TASK_LINKS },
    {
        key: 'automation', title: 'Automation', perm: 'automation.view', links: [
            { href: '/automation/workflows', label: 'Workflows', icon: '⇪', perm: 'automation.view' },
            { href: '/automation/checks', label: 'Checks', icon: '•', dot: 'bg-teal-300', count: 'checks', perm: ['automation.view', 'tasks.view'] },
        ],
    },
    { key: 'usage', links: [{ href: '/usage', label: 'Usage', icon: 'Σ', perm: 'usage.view' }] },
    {
        key: 'tools', title: 'Game Tools', rule: true, perm: 'tools.view', links: [
            { href: '/tools/assets', label: 'Asset Manager', icon: '◆', perm: 'tools.view', also: ['/tools/rsi', '/tools/reviews', '/tools/content'] },
            { href: '/tools/maps', label: 'Map Manager', icon: '▦', perm: 'tools.view' },
            { href: '/tools/map-converter', label: 'Map Converter', icon: '⇄', perm: 'tools.view' },
            { href: '/tools/perf', label: 'Performance', icon: '⏱', perm: 'tools.view' },
            { href: '/tools/crashes', label: 'Crashes', icon: '✖', perm: 'tools.view' },
            { href: '/tools/playtest', label: 'Playtest', icon: '☺', perm: 'tools.view' },
        ],
    },
    { key: 'account', title: 'Account', rule: true, links: [{ href: '/account/settings', label: 'Settings', icon: '⚙' }] },
    { key: 'admin', title: 'AdminCP', rule: true, links: ADMIN_LINKS },
]

/** The Asset Manager's sub pages (tabs across its top). */
export const ASSET_TABS = [
    ['/tools/assets', 'Assets'],
    ['/tools/rsi', 'RSI findings'],
    ['/tools/reviews', 'Reviews & QA'],
    ['/tools/content', 'Content'],
] as const

export const allowed = (perms: Perms | null | undefined, perm?: string | string[]) =>
    !perm || (Array.isArray(perm) ? perm : [perm]).every((k) => can(perms, k))

/** The sections and links this viewer may see; empty sections drop out. */
export function visibleNav(perms: Perms) {
    return NAV.filter((s) => allowed(perms, s.perm))
        .map((s) => ({ ...s, links: s.links.filter((l) => allowed(perms, l.perm)) }))
        .filter((s) => s.links.length || s.href)
}

export const isActive = (path: string, l: Pick<NavLink, 'href' | 'also'>) =>
    [l.href, ...(l.also ?? [])].some((h) => path === h || path.startsWith(`${h}/`))
