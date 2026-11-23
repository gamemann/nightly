import { notFound } from 'next/navigation'
import { parseSettings } from '../../../../../lib/projects-core.mjs'
import { canProject } from '../../../../../lib/permissions.mjs'
import { Workflows } from '~/components/automation/Workflows'
import { GamePage } from '~/components/Game'
import { AssetManager } from '~/components/tools/AssetManager'
import { CrashesTab } from '~/components/tools/CrashesTab'
import { MapManager } from '~/components/tools/MapManager'
import { PerfTab } from '~/components/tools/PerfTab'
import { PlaytestTab } from '~/components/tools/PlaytestTab'
import { ProjectBuilds, ProjectOverview, ProjectSettings } from '~/components/projects/ProjectView'
import { ProjectIcon } from '~/components/projects/ProjectIcon'
import { LinkTabs, NoAccess, PageHeader } from '~/components/shell/ui'
import { getViewer } from '~/server/auth'
import { db } from '~/server/db'
import { assertProject, projectScope } from '~/server/projectsRouter'

// One project: /projects/<slug>/<tab>. Each tab names the permission it needs (global or granted on this
// project or a folder above it) and the project types it applies to; other tabs are hidden.
// EXTENSION POINT: add a tab here (TABS + the switch below).
const ALL = ['game', 'game-addon', 'website'] as const
const GAME = ['game'] as const
const TABS: readonly (readonly [string, string, string | null, readonly string[]])[] = [
    ['overview', 'Overview', null, ALL],
    ['tasks', 'Tasks', 'tasks.view', ALL],
    ['perf', 'Perf', 'tools.view', GAME],
    ['playtest', 'Playtest', 'tools.view', GAME],
    ['crashes', 'Crashes', 'tools.view', GAME],
    ['assets', 'Assets', 'tools.view', ['game', 'game-addon']],
    ['maps', 'Maps', 'tools.view', ['game', 'game-addon']],
    ['workflows', 'Workflows', 'automation.view', ALL],
    ['builds', 'Builds', 'admin.builds', ALL],
    ['settings', 'Settings', 'projects.edit', ALL],
]

export default async function ProjectPage({ params }: { params: Promise<{ slug: string; tab?: string[] }> }) {
    const { slug, tab: rest } = await params
    const v = await getViewer()
    const p = await db.project.findUnique({ where: { slug }, include: { folder: { select: { name: true } } } })
    if (!p || !v) notFound()
    try {
        await assertProject(v, 'projects.view', p.id)
    } catch {
        return <NoAccess perm="projects.view" />
    }
    const scope = await projectScope(v)
    const has = (perm: string | null) => !perm || canProject(v.perms, scope, perm, p.id)
    const settings = parseSettings(p.settings)
    const forType = TABS.filter((t) => t[3].includes(p.type))
    const shown = forType.filter((t) => has(t[2]))
    const tab = rest?.[0] ?? 'overview'
    const cur = forType.find((t) => t[0] === tab)
    if (!cur || (rest?.length ?? 0) > 1) notFound()
    const game = typeof settings.perfGame === 'string' && settings.perfGame ? settings.perfGame : p.slug
    const base = `/projects/${p.slug}`
    const body = !shown.includes(cur) ? <NoAccess perm={cur[2] ?? 'projects.view'} />
        : tab === 'overview' ? <ProjectOverview slug={p.slug} />
        : tab === 'tasks' ? <GamePage slug={p.slug} />
        : tab === 'perf' ? <PerfTab projectSlug={game} />
        : tab === 'playtest' ? <PlaytestTab projectSlug={game} />
        : tab === 'crashes' ? <CrashesTab projectSlug={game} />
        : tab === 'assets' ? <AssetManager projectSlug={p.slug} />
        : tab === 'maps' ? <MapManager projectSlug={p.slug} />
        : tab === 'workflows' ? <Workflows projectSlug={p.slug} embedded />
        : tab === 'builds' ? <ProjectBuilds projectId={p.id} />
        : <ProjectSettings slug={p.slug} />
    return (
        <div>
            <PageHeader title={<span className="flex items-center gap-3"><ProjectIcon p={p} />{p.name}</span>}
                sub={<>{p.type}{p.folder ? ` · ${p.folder.name}` : ''} · <span className="font-mono">{p.slug}</span>{p.archived ? ' · archived' : ''}</>} />
            <LinkTabs tabs={shown.map(([k, label]) => [k === 'overview' ? base : `${base}/${k}`, label] as const)} active={tab === 'overview' ? base : `${base}/${tab}`} />
            {body}
        </div>
    )
}
