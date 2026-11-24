import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as P from './permissions.mjs'
import * as W from './passwords.mjs'

test('password hash round-trips and rejects wrong or malformed input', () => {
    const h = W.hashPassword('correct horse')
    assert.match(h, /^[0-9a-f]{32}:[0-9a-f]{64}$/)
    assert.equal(W.verifyPassword('correct horse', h), true)
    assert.equal(W.verifyPassword('correct hors', h), false)
    assert.equal(W.verifyPassword('correct horse', 'nope'), false)
    assert.equal(W.verifyPassword('correct horse', ''), false)
    assert.notEqual(W.hashPassword('correct horse'), h, 'salted')
    assert.throws(() => W.hashPassword('short'), /at least 8/)
})

test('a hash from the old single login (raw salt bytes) still verifies', async () => {
    const { randomBytes, scryptSync } = await import('node:crypto')
    const salt = randomBytes(16)
    const old = `${salt.toString('hex')}:${scryptSync('legacy-pass-1', salt, 32).toString('hex')}`
    assert.equal(W.verifyPassword('legacy-pass-1', old), true)
    assert.equal(W.verifyPassword('legacy-pass-2', old), false)
})

test('usernames are normalised and checked', () => {
    assert.equal(W.checkUsername(' Admin '), 'admin')
    assert.throws(() => W.checkUsername('a'))
    assert.throws(() => W.checkUsername('has space'))
})

test('wildcards and exact keys match', () => {
    assert.ok(P.matchPerm('*', 'admin.users'))
    assert.ok(P.matchPerm('admin.*', 'admin.users'))
    assert.ok(!P.matchPerm('admin.*', 'tasks.view'))
    assert.ok(!P.matchPerm('tasks.view', 'tasks.edit'))
    assert.ok(P.validGrant('admin.*') && P.validGrant('*') && P.validGrant('tasks.edit'))
    assert.ok(!P.validGrant('bogus.*') && !P.validGrant('tasks.fly'))
})

test('role grants union, user allow adds, user deny wins', () => {
    const perms = P.resolvePerms(['tasks.view', 'tools.*'], [{ perm: 'usage.viewAll', allow: true }, { perm: 'tools.run', allow: false }])
    assert.ok(P.can(perms, 'tasks.view'))
    assert.ok(!P.can(perms, 'tasks.edit'))
    assert.ok(P.can(perms, 'tools.edit'))
    assert.ok(!P.can(perms, 'tools.run'), 'deny beats role wildcard')
    assert.ok(P.can(perms, 'usage.viewAll'))
    const admin = P.resolvePerms(P.DEFAULT_ROLES.admin.grants, [])
    assert.ok(P.isAdmin(admin) && P.can(admin, 'admin.settings'))
    assert.ok(!P.isAdmin(P.resolvePerms(P.DEFAULT_ROLES.user.grants, [])))
    assert.ok(P.DEFAULT_ROLES.user.grants.every(P.validGrant))
})

test('project access inherits down the folder tree, for the user and their roles', () => {
    // folders: 1 Games > 2 Shooters > 3 Arena; 4 Websites
    const parents = new Map([[1, null], [2, 1], [3, 2], [4, null]])
    const projectFolder = new Map([[10, 3], [11, 4], [12, null]])
    const access = [
        { folderId: 1, userId: 7, perms: 'projects.view' },
        { projectId: 10, roleId: 2, perms: 'projects.edit,tasks.edit' },
        { folderId: 4, userId: 8, perms: '*' },
    ]
    const scope = { userId: 7, roleIds: [2], access, projectFolder, parents }
    const none = P.resolvePerms([], [])
    assert.ok(P.canProject(none, scope, 'projects.view', 10), 'from grandparent folder')
    assert.ok(P.canProject(none, scope, 'projects.edit', 10), 'from role on project')
    assert.ok(!P.canProject(none, scope, 'projects.view', 11), 'other user folder')
    assert.ok(!P.canProject(none, scope, 'projects.view', 12), 'no folder')
    assert.deepEqual(P.projectGrants(scope, 10).sort(), ['projects.edit', 'projects.view', 'tasks.edit'])
    assert.ok(P.canProject(P.resolvePerms(['projects.*'], []), scope, 'projects.delete', 12), 'global grant')
    const denied = P.resolvePerms([], [{ perm: 'projects.edit', allow: false }])
    assert.ok(!P.canProject(denied, scope, 'projects.edit', 10), 'user deny beats access')
    assert.ok(P.canProject(none, { ...scope, userId: 8, roleIds: [] }, 'projects.delete', 11))
})

test('folder tree sorts, nests and survives loops and orphans', () => {
    const tree = P.folderTree([
        { id: 1, name: 'Games', parentId: null, sort: 1 },
        { id: 2, name: 'B', parentId: 1, sort: 0 },
        { id: 3, name: 'A', parentId: 1, sort: 0 },
        { id: 4, name: 'Websites', parentId: null, sort: 0 },
        { id: 5, name: 'Orphan', parentId: 99, sort: 5 },
        { id: 6, name: 'L1', parentId: 7 },
        { id: 7, name: 'L2', parentId: 6 },
    ])
    assert.deepEqual(tree.map((f) => f.name), ['L1', 'L2', 'Websites', 'Games', 'Orphan'])
    assert.deepEqual(tree.find((f) => f.id === 1).children.map((f) => f.name), ['A', 'B'])
    const flat = P.flattenTree(tree)
    assert.deepEqual(flat.find((x) => x.folder.id === 2).path, ['Games', 'B'])
    assert.equal(flat.find((x) => x.folder.id === 2).depth, 1)
    const parents = new Map([[1, null], [2, 1], [3, 2]])
    assert.ok(P.wouldCycle(1, 3, parents))
    assert.ok(!P.wouldCycle(3, 1, parents))
    assert.deepEqual(P.ancestors(3, parents), [3, 2, 1])
})

test('repo classification for the project seed', async () => {
    const { classifyRepo, projectName } = await import('./projects-core.mjs')
    const { setRules } = await import('./naming-rules.mjs')
    const { readFileSync } = await import('node:fs')
    setRules(readFileSync(new URL('./naming-rules.fixture.json', import.meta.url), 'utf8'))
    const sib = new Set(['gs-core', 'dot-core', 'dot-legacy'])
    assert.deepEqual(classifyRepo('game-fatal-contact', 'godot'), { slug: 'game-fatal-contact', type: 'game', folder: ['Games'] })
    assert.equal(classifyRepo('dot-core', 'godot', sib), null)
    assert.equal(classifyRepo('dot-legacy', 'godot', sib).type, 'game-addon')
    assert.equal(classifyRepo('.wt-x'), null)
    assert.equal(classifyRepo('nightly-redesign', 'web'), null)
    assert.deepEqual(classifyRepo('mg-wipeout-maps', 'name').folder, ['Game Addons', 'Map packs'])
    assert.deepEqual(classifyRepo('mg-wipeout', 'godot').folder, ['Games', 'Minigames'])
    assert.equal(classifyRepo('website-city', 'name').type, 'website')
    assert.equal(classifyRepo('buildz', 'none'), null)
    assert.equal(classifyRepo('fc-dm-maps', 'none').type, 'game-addon')
    assert.equal(classifyRepo('natural-disasters', 'godot').type, 'game')
    assert.equal(projectName('game-fatal-contact', 'game'), 'Fatal Contact')
    assert.equal(projectName('gs-npc-ai', 'game-addon'), 'gs-npc-ai')
})

test('ssh config parsing for node import, and spec validation', async () => {
    const { parseSshConfig, checkSpecs } = await import('./node-specs.mjs')
    const cfg = parseSshConfig('Host *\n  User nobody\nHost box1 b1\n  HostName 10.0.0.5\n  User dev # c\n  Port 2222\nHost box2\n  hostname=box2.example\n')
    assert.deepEqual(cfg.box1, { hostname: '10.0.0.5', user: 'dev', port: 2222 })
    assert.deepEqual(cfg.b1, cfg.box1)
    assert.equal(cfg.box2.hostname, 'box2.example')
    assert.equal(cfg['*'], undefined)
    assert.deepEqual(checkSpecs('{"buildSlots":2,"offloadKinds":["gpu"]}'), { buildSlots: 2, offloadKinds: ['gpu'] })
    assert.throws(() => checkSpecs({ heavySlots: -1 }))
    assert.throws(() => checkSpecs({ offloadKinds: ['fly'] }))
})

test('procedure permissions by router: reads, writes, unlisted routers, and the user role', () => {
    assert.equal(P.procedurePerm('item.list', 'query'), 'tasks.view')
    assert.equal(P.procedurePerm('item.update', 'mutation'), 'tasks.edit')
    assert.equal(P.procedurePerm('setting.all', 'query'), null)
    assert.equal(P.procedurePerm('setting.set', 'mutation'), 'admin.settings')
    assert.equal(P.procedurePerm('project.list', 'query'), null)
    for (const r of Object.values(P.ROUTER_PERMS)) for (const k of r) if (k) assert.ok(P.PERMISSION_KEYS.includes(k), k)
    const user = P.resolvePerms(P.DEFAULT_ROLES.user.grants)
    assert.equal(P.can(user, P.procedurePerm('item.update', 'mutation')), true)
    assert.equal(P.can(user, P.procedurePerm('run.list', 'query')), false)
    assert.equal(P.can(user, P.procedurePerm('perf.list', 'query')), true)
    assert.equal(P.can(user, P.procedurePerm('perf.setBudget', 'mutation')), false)
})
