// Permission catalog and resolution, shared by the panel (src/server/viewer.ts, tRPC requirePerm)
// and the CLI (`nightly role grant`). Pure functions: no database, so lib/permissions.test.mjs
// covers them directly.
//
// A grant is a key (`tasks.edit`) or a wildcard (`*`, `admin.*`). A user's permissions are the
// union of their roles' grants plus their own allow grants, minus their own deny grants
// (allow=false). Project-scoped checks (projects.*, tasks.* on one project) also pass through a
// ProjectAccess row on the project or on any folder above it.

/** Every permission the panel checks. area groups them in the role editor. */
export const PERMISSIONS = [
    ['projects.view', 'projects', 'See projects (all of them; otherwise only those given by project access)'],
    ['projects.create', 'projects', 'Create projects and folders'],
    ['projects.edit', 'projects', 'Edit projects and folders'],
    ['projects.delete', 'projects', 'Delete projects and folders'],
    ['tasks.view', 'tasks', 'See tasks, issues, checks and items'],
    ['tasks.edit', 'tasks', 'Add, edit and move tasks; write notes'],
    ['transcripts.view', 'transcripts', 'See own transcripts'],
    ['transcripts.viewAll', 'transcripts', 'See every user\'s transcripts'],
    ['transcripts.run', 'transcripts', 'Start agent transcripts'],
    ['agents.view', 'agents', 'See agents, claims and messages'],
    ['agents.edit', 'agents', 'Message, release and manage agents'],
    ['automation.view', 'automation', 'See workflows and checks'],
    ['automation.edit', 'automation', 'Edit workflows and checks'],
    ['usage.view', 'usage', 'See own usage'],
    ['usage.viewAll', 'usage', 'See everyone\'s usage'],
    ['tools.view', 'tools', 'See game tools (assets, maps, perf, crashes, playtests, reviews)'],
    ['tools.edit', 'tools', 'Change game tool data (reviews, verdicts, budgets)'],
    ['tools.run', 'tools', 'Run game tools (map converter, perf runs)'],
    ['playtest.trigger', 'tools', 'Start bot playtests'],
    ['nodes.view', 'nodes', 'See nodes'],
    ['nodes.use', 'nodes', 'Run work on nodes'],
    ['account.edit', 'account', 'Change own name and password'],
    ['admin.users', 'admin', 'Manage users'],
    ['admin.roles', 'admin', 'Manage roles and grants'],
    ['admin.nodes', 'admin', 'Manage nodes, node users and links'],
    ['admin.comm', 'admin', 'Manage communication channels'],
    ['admin.databases', 'admin', 'Manage database connections'],
    ['admin.builds', 'admin', 'Manage build configs'],
    ['admin.schedules', 'admin', 'Manage schedules'],
    ['admin.prompts', 'admin', 'Manage prompts'],
    ['admin.jobs', 'admin', 'Manage jobs and scripts'],
    ['admin.runs', 'admin', 'See runs and reports'],
    ['admin.web', 'admin', 'Manage web checks'],
    ['admin.crashlog', 'admin', 'See the crash log'],
    ['admin.settings', 'admin', 'Change workspace settings'],
].map(([key, area, label]) => ({ key, area, label }))

export const PERMISSION_KEYS = PERMISSIONS.map((p) => p.key)

/** The roles every workspace has. builtin: cannot be deleted or renamed. */
export const DEFAULT_ROLES = {
    admin: { description: 'Everything', grants: ['*'] },
    user: {
        description: 'Tasks, own transcripts and usage, game tools (read), agents (read); projects via project access',
        grants: ['tasks.view', 'tasks.edit', 'transcripts.view', 'transcripts.run', 'usage.view', 'automation.view', 'tools.view', 'agents.view', 'account.edit'],
    },
}

/** Is `pattern` a valid grant (`*`, `<area>.*` or a known key)? */
export function validGrant(pattern) {
    const p = String(pattern ?? '')
    if (p === '*') return true
    if (p.endsWith('.*')) return PERMISSIONS.some((x) => x.area === p.slice(0, -2))
    return PERMISSION_KEYS.includes(p)
}

export function matchPerm(pattern, key) {
    if (pattern === '*' || pattern === key) return true
    return pattern.endsWith('.*') && key.startsWith(pattern.slice(0, -1))
}

/** roleGrants: perm strings from the user's roles. userGrants: [{perm, allow}] on the user. */
export function resolvePerms(roleGrants = [], userGrants = []) {
    const allow = new Set(roleGrants)
    const deny = new Set()
    for (const g of userGrants) (g.allow === false || g.allow === 0 ? deny : allow).add(g.perm)
    return { allow: [...allow].sort(), deny: [...deny].sort() }
}

export function can(perms, key) {
    if (!perms) return false
    if (perms.deny.some((p) => matchPerm(p, key))) return false
    return perms.allow.some((p) => matchPerm(p, key))
}

export const isAdmin = (perms) => can(perms, 'admin.users') && can(perms, 'admin.roles')

/** Folder ids from `folderId` up to the root, nearest first. Stops on a cycle. parents: Map<id, parentId|null>. */
export function ancestors(folderId, parents) {
    const out = []
    const seen = new Set()
    for (let f = folderId; f != null && !seen.has(f); f = parents.get(f) ?? null) { seen.add(f); out.push(f) }
    return out
}

/** Would making `parentId` the parent of `folderId` create a loop? */
export function wouldCycle(folderId, parentId, parents) {
    if (parentId == null) return false
    return ancestors(parentId, parents).includes(folderId)
}

/**
 * The perms a user has on one project through ProjectAccess rows: rows for the user or one of
 * their roles on the project itself or on its folder or any folder above it.
 * scope = { userId, roleIds, access: [{projectId, folderId, userId, roleId, perms}], projectFolder: Map<projectId, folderId|null>, parents: Map<folderId, parentId|null> }
 */
export function projectGrants(scope, projectId) {
    const folders = new Set(ancestors(scope.projectFolder.get(projectId) ?? null, scope.parents))
    const roleIds = new Set(scope.roleIds ?? [])
    const out = new Set()
    for (const a of scope.access ?? []) {
        if (!(a.userId != null ? a.userId === scope.userId : a.roleId != null && roleIds.has(a.roleId))) continue
        if (!(a.projectId != null ? a.projectId === projectId : a.folderId != null && folders.has(a.folderId))) continue
        for (const p of String(a.perms ?? '').split(',').map((s) => s.trim()).filter(Boolean)) out.add(p)
    }
    return [...out]
}

/** Can the user do `key` on project `projectId`? A global grant or a project/folder access grant; a user deny always wins. */
export function canProject(perms, scope, key, projectId) {
    if (perms?.deny.some((p) => matchPerm(p, key))) return false
    if (can(perms, key)) return true
    return projectGrants(scope, projectId).some((p) => matchPerm(p, key))
}

/** Folders as a tree: [{...folder, children: [...]}] sorted by sort then name. A folder whose parent is missing or in a loop becomes a root. */
export function folderTree(folders) {
    const byId = new Map(folders.map((f) => [f.id, { ...f, children: [] }]))
    const parents = new Map(folders.map((f) => [f.id, f.parentId ?? null]))
    const roots = []
    for (const f of byId.values()) {
        const p = f.parentId != null ? byId.get(f.parentId) : null
        const loops = p ? ancestors(f.parentId, parents).includes(f.id) : false
        if (p && !loops) p.children.push(f)
        else roots.push(f)
    }
    const sort = (list) => { list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || String(a.name).localeCompare(String(b.name))); for (const f of list) sort(f.children); return list }
    return sort(roots)
}

/** Flatten a tree to [{folder, depth, path}] in display order (path: names from the root). */
export function flattenTree(tree, depth = 0, path = []) {
    const out = []
    for (const f of tree) {
        const p = [...path, f.name]
        out.push({ folder: f, depth, path: p })
        out.push(...flattenTree(f.children, depth + 1, p))
    }
    return out
}

/**
 * The permission each tRPC procedure of the older routers needs, by router name: [query, mutation].
 * null = signed in is enough. Routers not listed here check their own (requirePerm in
 * src/server/trpc.ts); a listed router may still add a stricter requirePerm on one procedure.
 */
export const ROUTER_PERMS = {
    item: ['tasks.view', 'tasks.edit'],
    note: ['tasks.view', 'tasks.edit'],
    game: ['tasks.view', 'tasks.edit'],
    attachment: ['tasks.view', 'tasks.edit'],
    run: ['admin.runs', 'admin.runs'],
    schedule: ['admin.schedules', 'admin.schedules'],
    prompt: ['admin.prompts', 'admin.prompts'],
    qa: ['tools.view', 'tools.edit'],
    feed: ['tools.view', 'tools.edit'],
    assets: ['tools.view', 'tools.edit'],
    review: ['tools.view', 'tools.edit'],
    perf: ['tools.view', 'tools.edit'],
    agent: ['agents.view', 'agents.edit'],
    setting: [null, 'admin.settings'],
    usage: ['usage.view', 'admin.settings'],
}

/** The permission a procedure path (`item.list`) of type query|mutation|subscription needs, or null. */
export function procedurePerm(path, type) {
    const rule = ROUTER_PERMS[String(path).split('.')[0]]
    if (!rule) return null
    return type === 'mutation' ? rule[1] : rule[0]
}
