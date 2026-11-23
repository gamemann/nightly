// Local users and SSH keys on a node, for the panel's "create user on node" and node-to-node connect flows.
// Needs root, or passwordless sudo, to create other users; without it the op fails with a clear message.
import { spawnSync } from 'node:child_process'
import os from 'node:os'

const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/
const HOST_RE = /^[A-Za-z0-9._:-]{1,253}$/
const KEY_RE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp\d+|sk-ssh-ed25519@openssh\.com) [A-Za-z0-9+/=]+( [^\r\n]*)?$/
const err = (code, msg) => Object.assign(new Error(msg), { code })
const isRoot = () => process.getuid?.() === 0
const run = (argv, o = {}) => spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', timeout: o.timeout ?? 20_000, input: o.input, env: o.env ?? process.env })
const priv = (argv) => (isRoot() ? argv : ['sudo', '-n', ...argv])

export const checkUser = (u) => { if (!USER_RE.test(String(u ?? ''))) throw err('bad-user', 'username: lowercase letters, digits, _ or -, up to 32'); return u }
export const checkKey = (k) => { if (!KEY_RE.test(String(k ?? '').trim())) throw err('bad-key', 'not an SSH public key'); return String(k).trim() }

export const userExists = (u) => run(['id', '-u', checkUser(u)]).status === 0

/** argv to run as another local user: direct when it is us, runuser as root, sudo -n -u otherwise. */
export function asUser(user, argv) {
    if (user === os.userInfo().username) return argv
    return isRoot() ? ['runuser', '-u', user, '--', ...argv] : ['sudo', '-n', '-u', user, ...argv]
}

function ensureAvailable(user) { if (!userExists(user)) throw err('no-user', `user ${user} does not exist on this node`) }

export function authorizeKey({ username, publicKey }) {
    checkUser(username); const key = checkKey(publicKey); ensureAvailable(username)
    const sh = 'umask 077; mkdir -p "$HOME/.ssh"; touch "$HOME/.ssh/authorized_keys"; grep -qxF -- "$1" "$HOME/.ssh/authorized_keys" || printf "%s\\n" "$1" >> "$HOME/.ssh/authorized_keys"'
    const r = run(asUser(username, ['sh', '-c', sh, '_', key]))
    if (r.status !== 0) throw err('authorize-failed', (r.stderr || 'could not write authorized_keys').trim())
    return { username, authorized: true }
}

/** Generate (or reuse) an ed25519 key for a local user; returns its public half. */
export function generateKey({ username = os.userInfo().username, comment } = {}) {
    checkUser(username); ensureAvailable(username)
    const sh = 'umask 077; mkdir -p "$HOME/.ssh"; [ -f "$HOME/.ssh/id_ed25519" ] || ssh-keygen -q -t ed25519 -N "" -C "$1" -f "$HOME/.ssh/id_ed25519" >&2; cat "$HOME/.ssh/id_ed25519.pub"'
    const r = run(asUser(username, ['sh', '-c', sh, '_', comment || `nightly-${os.hostname()}-${username}`]))
    if (r.status !== 0) throw err('keygen-failed', (r.stderr || 'ssh-keygen failed').trim())
    return { username, publicKey: r.stdout.trim() }
}

export function createUser({ username, password, publicKey, generateKey: gen, allowCreate = true }) {
    checkUser(username)
    if (publicKey) checkKey(publicKey)
    let created = false
    if (!userExists(username)) {
        if (!allowCreate) throw err('disabled', 'creating users is disabled on this node (NIGHTLY_NODE_ALLOW_USER_CREATE=false)')
        const r = run(priv(['useradd', '-m', '-s', '/bin/bash', username]))
        if (r.status !== 0) throw err('useradd-failed', (r.stderr || r.stdout || 'useradd failed (need root or passwordless sudo)').trim())
        created = true
    }
    if (password) {
        if (String(password).length < 8 || /[\r\n:]/.test(password)) throw err('bad-password', 'password: at least 8 characters, no colon or newline')
        const r = run(priv(['chpasswd']), { input: `${username}:${password}\n` })
        if (r.status !== 0) throw err('chpasswd-failed', (r.stderr || 'chpasswd failed').trim())
    }
    const out = { username, created, passwordSet: !!password, keyAuthorized: false }
    if (publicKey) { authorizeKey({ username, publicKey }); out.keyAuthorized = true }
    if (gen) out.publicKey = generateKey({ username }).publicKey
    return out
}

/** Can the daemon's user (or `as`) ssh to host as username? Key auth by default (BatchMode); password through sshpass. */
export function sshCheck({ host, port = 22, username, password, identity, as }) {
    if (!HOST_RE.test(String(host ?? ''))) throw err('bad-host', 'host: a hostname or address')
    checkUser(username)
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw err('bad-port', 'port: 1-65535')
    const opts = ['-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', '-p', String(port)]
    if (identity) { if (/[^\w./-]/.test(identity)) throw err('bad-identity', 'identity: a path'); opts.push('-i', identity, '-o', 'IdentitiesOnly=yes') }
    let argv
    const env = { ...process.env }
    if (password) {
        if (run(['sh', '-c', 'command -v sshpass']).status !== 0) throw err('no-sshpass', 'password checks need sshpass on this node')
        env.SSHPASS = password
        argv = ['sshpass', '-e', 'ssh', ...opts, '-o', 'PreferredAuthentications=password', '-o', 'PubkeyAuthentication=no', `${username}@${host}`, 'true']
    } else argv = ['ssh', '-o', 'BatchMode=yes', ...opts, `${username}@${host}`, 'true']
    const t0 = Date.now()
    const r = run(as ? asUser(checkUser(as), argv) : argv, { env, timeout: 15_000 })
    return { ok: r.status === 0, ms: Date.now() - t0, message: r.status === 0 ? 'ok' : (r.stderr || 'ssh failed').trim().split('\n').pop() }
}
