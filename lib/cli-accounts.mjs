// CLI for users, roles, folders, projects, project access and the node registry:
// nightly user|role|folder|project|access|node|dbconn|build <sub> ... (see ACCOUNT_HELP).
// Passwords: --password-stdin (preferred) or --password; with neither, a random one is printed once.
import * as AC from './accounts.mjs'
import * as PJ from './projects.mjs'
import * as N from './nodes.mjs'
import { PERMISSIONS } from './permissions.mjs'
import { randomPassword } from './passwords.mjs'

export const ACCOUNT_COMMANDS = ['user', 'users', 'role', 'roles', 'folder', 'folders', 'project', 'projects', 'access', 'node', 'nodes', 'dbconn', 'build', 'builds']
export const ACCOUNT_BOOL = ['passwordStdin', 'tls', 'heavy']

export const ACCOUNT_HELP = `  user list | show U | add U [--name N] [--roles a,b] [--password-stdin | --password P] | set U [--name N] [--roles a,b] [--password-stdin | --password P] [--disable | --enable] | rm U
      panel logins (scrypt); no password given = a random one printed once; disabling or a new password ends the user's sessions; the last enabled admin cannot be removed
  user perms U                                  the user's effective permissions (role grants + user allow/deny)
  role list | add NAME [--description D] [--grants a,b] | rm NAME | grant role:NAME|user:U PERM [allow|deny|revoke] | perms
      roles admin (everything) and user are builtin; PERM is a key from \`role perms\` or a wildcard like tools.* (deny wins; roles only allow)
  folder list | add NAME [--parent ID|PATH] [--sort N] | set ID|PATH [--name N] [--parent ID|PATH|-] [--sort N] | rm ID|PATH
  project list [--type website|game|game-addon] [--folder ID|PATH] [--q TEXT] | show SLUG | add SLUG [--name N] [--type T] [--folder F] [--repo-path P] [--repo-url U]
  project set SLUG [--name ..] [--type ..] [--folder F|-] [--repo-path ..] [--repo-url ..] [--settings JSON] [--archive | --unarchive] | rm SLUG
  project seed [--roots a:b] [--dry-run]         create projects from the repos under setting projectRoots (and those the DB knows); idempotent
  access list | grant user:U|role:R project:SLUG|folder:ID|PATH [--perms projects.view,projects.edit] | revoke ID     folder access covers subfolders
  node list | show N | add NAME [--type planet|station] [--host H] [--port 4001] [--tls] [--specs JSON] [--notes T] | set N [..] | rm N
  node token N                                  rotate the node token (printed once; stored as sha256)
  node probe [N] | planet                       probe this machine's cpu/ram/gpu/disks into N (default: the planet) | create the planet if missing
  node import-ssh ALIAS [--name N] [--config FILE]   a station from an ssh config Host (host/user/port only; no credentials read)
  node users N | node user-add N U [--os-user X] | node user-rm N U | node links | node link FROM TO OS_USER [--auth ssh-key|password] | node unlink ID
  dbconn list | add NAME [--kind clickhouse|postgres|mysql|sqlite] [--host H] [--port P] [--database D] [--username U] [--secret-ref ENV_NAME] | rm NAME
  build list [--project SLUG] | set SLUG NAME --command C [--heavy] [--node-kinds build,gpu] [--timeout S (0 = unlimited)] [--disable | --enable] | rm SLUG NAME`

const csv = (v) => (v === undefined || v === true ? undefined : String(v).split(',').map((s) => s.trim()).filter(Boolean))
const num = (v) => (v === undefined ? undefined : Number(v))

function password(opt, readStdin, required) {
    if (opt.passwordStdin) return { pw: readStdin().replace(/\r?\n$/, ''), shown: false }
    if (opt.password !== undefined && opt.password !== true) return { pw: String(opt.password), shown: false }
    return required ? { pw: randomPassword(), shown: true } : { pw: undefined, shown: false }
}

const table = (rows, cols) => rows.length ? rows.map((r) => cols.map(([k, w]) => String(r[k] ?? '-').padEnd(w)).join(' ').trimEnd()).join('\n') : '(none)'

export async function runAccountCommand(cmd, { db, pos, opt, out, die, readStdin }) {
    const sub = pos.shift() ?? 'list'
    const need = (what) => pos.shift() ?? die(`${cmd} ${sub}: ${what} required (nightly help)`)
    const c = { users: 'user', roles: 'role', folders: 'folder', projects: 'project', nodes: 'node', builds: 'build' }[cmd] ?? cmd
    if (c === 'user') {
        if (sub === 'list') return out(AC.listUsers(db), () => table(AC.listUsers(db), [['username', 16], ['roles', 14], ['name', 20], ['lastLoginAt', 25], ['disabledAt', 0]]))
        if (sub === 'show' || sub === 'perms') { const p = AC.userPerms(db, need('username')); return out(p, () => `${p.username}  roles ${p.roles.join(',') || '-'}\nallow ${p.allow.join(' ') || '-'}\ndeny  ${p.deny.join(' ') || '-'}`) }
        if (sub === 'add') {
            const username = need('username'), { pw, shown } = password(opt, readStdin, true)
            const u = AC.createUser(db, { username, password: pw, name: opt.name ?? '', roles: csv(opt.roles) ?? ['user'] })
            return out({ ...u, ...(shown ? { password: pw } : {}) }, () => `created ${u.username}${shown ? `\npassword (shown once): ${pw}` : ''}`)
        }
        if (sub === 'set') {
            const username = need('username'), { pw } = password(opt, readStdin, false)
            const u = AC.editUser(db, username, { password: pw, name: opt.name, roles: csv(opt.roles), disabled: opt.disable ? true : opt.enable ? false : undefined })
            return out(u, () => `updated ${u.username}`)
        }
        if (sub === 'rm' || sub === 'delete') { const r = AC.deleteUser(db, need('username')); return out(r, () => `deleted ${r.username}`) }
    }
    if (c === 'role') {
        if (sub === 'list') return out(AC.listRoles(db), () => table(AC.listRoles(db), [['name', 14], ['users', 6], ['builtin', 8], ['grants', 0]]))
        if (sub === 'perms') return out(PERMISSIONS, () => PERMISSIONS.map((p) => `${p.key.padEnd(22)} ${p.area.padEnd(12)} ${p.label}`).join('\n'))
        if (sub === 'add') { const r = AC.createRole(db, { name: need('name'), description: opt.description ?? '', grants: csv(opt.grants) ?? [] }); return out(r, () => `created role ${r.name}`) }
        if (sub === 'rm' || sub === 'delete') { const r = AC.deleteRole(db, need('name')); return out(r, () => `deleted role ${r.name}`) }
        if (sub === 'grant') { const target = need('role:NAME or user:U'), perm = need('permission'); const r = AC.setGrant(db, target, perm, pos.shift() ?? 'allow'); return out(r, () => `${r.target} ${r.perm}: ${r.mode}`) }
    }
    if (c === 'folder') {
        if (sub === 'list') return out(PJ.listFolders(db), () => table(PJ.listFolders(db), [['id', 4], ['parentId', 8], ['projects', 8], ['name', 0]]))
        if (sub === 'add') { const f = PJ.createFolder(db, { name: need('name'), parent: opt.parent, sort: num(opt.sort) ?? 0 }); return out(f, () => `created folder ${f.id} ${f.name}`) }
        if (sub === 'set') { const f = PJ.editFolder(db, need('folder'), { name: opt.name, parent: opt.parent === '-' ? null : opt.parent, sort: num(opt.sort) }); return out(f, () => `updated folder ${f.id} ${f.name}`) }
        if (sub === 'rm' || sub === 'delete') { const r = PJ.deleteFolder(db, need('folder')); return out(r, () => `deleted folder ${r.name ?? r.id}`) }
    }
    if (c === 'project') {
        if (sub === 'list') { const rows = PJ.listProjects(db, { type: opt.type, folder: opt.folder, q: opt.q }); return out(rows, () => table(rows, [['slug', 28], ['type', 11], ['folder', 18], ['repoPath', 0]])) }
        if (sub === 'show') { const p = PJ.projectRow(db, need('slug')); return out(p, () => Object.entries(p).map(([k, v]) => `${k.padEnd(10)} ${v ?? '-'}`).join('\n')) }
        if (sub === 'seed') { const r = PJ.seed(db, { roots: opt.roots ? String(opt.roots).split(':') : undefined, dryRun: !!opt.dryRun }); return out(r, () => `${opt.dryRun ? 'would add' : 'added'} ${Array.isArray(r.added) ? r.added.length : r.added} project(s) in ${r.folders} folder(s); skipped: ${r.skipped.join(' ') || '-'}`) }
        if (sub === 'add') { const p = PJ.createProject(db, { slug: need('slug'), name: opt.name, type: opt.type, folder: opt.folder, repoPath: opt.repoPath ?? '', repoUrl: opt.repoUrl ?? '' }); return out(p, () => `created project ${p.slug}`) }
        if (sub === 'set') {
            const slug = need('slug')
            const p = PJ.editProject(db, slug, { name: opt.name, type: opt.type, folder: opt.folder === '-' ? null : opt.folder, repoPath: opt.repoPath, repoUrl: opt.repoUrl, settings: opt.settings === undefined ? undefined : JSON.parse(opt.settings), archived: opt.archive ? true : opt.unarchive ? false : undefined })
            return out(p, () => `updated project ${p.slug}`)
        }
        if (sub === 'rm' || sub === 'delete') { const r = PJ.deleteProject(db, need('slug')); return out(r, () => `deleted project ${r.slug}`) }
    }
    if (c === 'access') {
        if (sub === 'list') { const rows = PJ.listAccess(db); return out(rows, () => table(rows.map((r) => ({ ...r, who: r.user ? `user:${r.user}` : `role:${r.role}`, on: r.project ? `project:${r.project}` : `folder:${r.folder}` })), [['id', 4], ['who', 20], ['on', 30], ['perms', 0]])) }
        if (sub === 'grant') { const r = PJ.grantAccess(db, need('user:U or role:R'), need('project:SLUG or folder:F'), csv(opt.perms) ?? ['projects.view']); return out(r, () => `access ${r.id} granted`) }
        if (sub === 'revoke' || sub === 'rm') { const r = PJ.revokeAccess(db, need('id')); return out(r, () => `revoked access ${r.id}`) }
    }
    if (c === 'node') {
        const specs = opt.specs === undefined ? undefined : JSON.parse(opt.specs)
        if (sub === 'list') { const rows = N.listNodes(db); return out(rows, () => table(rows, [['name', 16], ['type', 8], ['status', 8], ['port', 6], ['users', 6], ['host', 0]])) }
        if (sub === 'show') { const n = N.publicNode(N.nodeRow(db, need('node'))); return out(n, () => Object.entries(n).map(([k, v]) => `${k.padEnd(10)} ${v ?? '-'}`).join('\n')) }
        if (sub === 'add') { const r = N.createNode(db, { name: need('name'), type: opt.type, host: opt.host ?? '', port: opt.port, tls: !!opt.tls, specs, notes: opt.notes ?? '' }); return out(r, () => `created node ${r.node.name}\ntoken (shown once): ${r.token}`) }
        if (sub === 'set') { const n = N.editNode(db, need('node'), { name: opt.name, type: opt.type, host: opt.host, port: opt.port, tls: opt.tls ? true : undefined, specs, notes: opt.notes }); return out(n, () => `updated node ${n.name}`) }
        if (sub === 'rm' || sub === 'delete') { const r = N.deleteNode(db, need('node')); return out(r, () => `deleted node ${r.name}`) }
        if (sub === 'token') { const r = N.rotateToken(db, need('node')); return out(r, () => `new token for ${r.node} (shown once): ${r.token}`) }
        if (sub === 'planet') { const n = N.seedPlanet(db); return out(n, () => `planet ${n.name}`) }
        if (sub === 'probe') { const ref = pos.shift(); const n = ref ? N.probeInto(db, ref) : N.seedPlanet(db); return out(n, () => `probed ${n.name}: ${n.specs}`) }
        if (sub === 'import-ssh') {
            const r = N.importSsh(db, need('ssh alias'), { name: opt.name, configFile: opt.config })
            return out(r, () => `${r.token ? 'created' : 'updated'} station ${r.node.name}${r.sshUser ? ` (linked from the planet as ${r.sshUser})` : ''}${r.token ? `\ntoken (shown once): ${r.token}` : ''}`)
        }
        if (sub === 'users') { const rows = N.listNodeUsers(db, need('node')); return out(rows, () => table(rows, [['user', 16], ['osUser', 0]])) }
        if (sub === 'user-add') { const rows = N.addNodeUser(db, need('node'), need('user'), opt.osUser); return out(rows, () => table(rows, [['user', 16], ['osUser', 0]])) }
        if (sub === 'user-rm') { const rows = N.removeNodeUser(db, need('node'), need('user')); return out(rows, () => table(rows, [['user', 16], ['osUser', 0]])) }
        if (sub === 'links') { const rows = N.listLinks(db); return out(rows, () => table(rows, [['id', 4], ['from', 14], ['to', 14], ['username', 12], ['auth', 9], ['status', 0]])) }
        if (sub === 'link') { const rows = N.addLink(db, need('from'), need('to'), need('os user'), opt.auth ?? 'ssh-key'); return out(rows, () => `linked (${rows.length} link(s))`) }
        if (sub === 'unlink') { const r = N.removeLink(db, need('id')); return out(r, () => `removed link ${r.id}`) }
    }
    if (c === 'dbconn') {
        if (sub === 'list') { const rows = N.listDbConns(db); return out(rows, () => table(rows, [['name', 16], ['kind', 11], ['database', 14], ['username', 12], ['secretRef', 16], ['host', 0]])) }
        if (sub === 'add') { const r = N.createDbConn(db, { name: need('name'), kind: opt.kind, host: opt.host, port: opt.port, database: opt.database, username: opt.username, secretRef: opt.secretRef }); return out(r, () => `created db connection ${r.name}`) }
        if (sub === 'rm' || sub === 'delete') { const r = N.deleteDbConn(db, need('name')); return out(r, () => `deleted db connection ${r.name}`) }
    }
    if (c === 'build') {
        if (sub === 'list') { const rows = N.listBuilds(db, opt.project); return out(rows, () => table(rows, [['project', 24], ['name', 14], ['heavy', 6], ['nodeKinds', 12], ['timeout', 8], ['enabled', 8], ['command', 0]])) }
        if (sub === 'set') { const b = N.setBuild(db, need('slug'), need('name'), { command: opt.command, heavy: opt.heavy ? true : undefined, nodeKinds: opt.nodeKinds, timeout: num(opt.timeout), enabled: opt.disable ? false : opt.enable ? true : undefined }); return out(b, () => `build ${b.project}/${b.name} saved`) }
        if (sub === 'rm' || sub === 'delete') { const r = N.deleteBuild(db, need('slug'), need('name')); return out(r, () => `deleted build ${r.project}/${r.name}`) }
    }
    die(`unknown ${cmd} command "${sub}" (nightly help)`)
}
