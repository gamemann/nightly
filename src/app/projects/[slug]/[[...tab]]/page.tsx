import { notFound } from 'next/navigation'
import { parseSettings } from '../../../../../lib/projects-core.mjs'
import { GamePage } from '~/components/Game'
import { Perf } from '~/components/Perf'
import { ProjectBuilds, ProjectOverview, ProjectSettings } from '~/components/projects/ProjectView'
import { ProjectIcon } from '~/components/projects/ProjectIcon'
import { LinkTabs, NoAccess, PageHeader, Scaffold } from '~/components/shell/ui'
import { allowed } from '~/lib/nav'
import { getViewer } from '~/server/auth'
import { db } from '~/server/db'
import { assertProject } from '~/server/projectsRouter'

// One project: /projects/<slug>/<tab>. Each tab names the permission it needs; tabs the viewer
// lacks are hidden. EXTENSION POINT: a later phase adds a tab here (TABS + the switch below).
const TABS = [
    ['overview', 'Overview', null],
    ['tasks', 'Tasks', 'tasks.view'],
    ['perf', 'Perf', 'tools.view'],
    ['assets', 'Assets', 'tools.view'],
    ['maps', 'Maps', 'tools.view'],
    ['crashes', 'Crashes', 'tools.view'],
    ['playtest', 'Playtest', 'tools.view'],
    ['builds', 'Builds', 'admin.builds'],
    ['settings', 'Settings', 'edit'],
] as const

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
    const canEdit = await assertProject(v, 'projects.edit', p.id).then(() => true, () => false)
    const settings = parseSettings(p.settings)
    const shown = TABS.filter(([, , perm]) => (perm === 'edit' ? canEdit : !perm || allowed(v.perms, perm)))
    const tab = rest?.[0] ?? 'overview'
    const cur = TABS.find((t) => t[0] === tab)
    if (!cur || (rest?.length ?? 0) > 1) notFound()
    const base = `/projects/${p.slug}`
    const body = !shown.includes(cur) ? <NoAccess perm={cur[2] === 'edit' ? 'projects.edit' : cur[2] ?? 'projects.view'} />
        : tab === 'overview' ? <ProjectOverview slug={p.slug} />
        : tab === 'tasks' ? <GamePage slug={p.slug} />
        : tab === 'perf' ? <Perf slug={[typeof settings.perfGame === 'string' ? settings.perfGame : p.slug]} />
        : tab === 'builds' ? <ProjectBuilds projectId={p.id} />
        : tab === 'settings' ? <ProjectSettings slug={p.slug} />
        : <Scaffold title={cur[1]} phase={4} links={tab === 'assets' ? [['/tools/assets', 'Asset Manager']] : tab === 'maps' ? [['/tools/maps', 'All maps']] : [['/tools/playtest', 'Playtest & crashes']]}>
            The per-project {cur[1].toLowerCase()} view lands in phase 4. Until then the workspace-wide page has this project&apos;s data.
        </Scaffold>
    return (
        <div>
            <PageHeader title={<span className="flex items-center gap-3"><ProjectIcon p={p} />{p.name}</span>}
                sub={<>{p.type}{p.folder ? ` · ${p.folder.name}` : ''} · <span className="font-mono">{p.slug}</span>{p.archived ? ' · archived' : ''}</>} />
            <LinkTabs tabs={shown.map(([k, label]) => [k === 'overview' ? base : `${base}/${k}`, label] as const)} active={tab === 'overview' ? base : `${base}/${tab}`} />
            {body}
        </div>
    )
}
