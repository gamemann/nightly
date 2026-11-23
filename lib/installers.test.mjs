import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootstrap } from './bootstrap.mjs'
import { discoverBoxes } from './node-discover.mjs'
import { detectCompose, detectAndRegister, parseEnv } from './db-detect.mjs'
import { listNodes } from './nodes.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ni-test-'))
const sh = (args, env = {}) => spawnSync('bash', [path.join(ROOT, 'install/install-node.sh'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

test('install-node.sh: station install, idempotent, token kept, uninstall', () => {
    const t = tmp(), p = path.join(t, 'p')
    const a = sh(['--station', '--prefix', p, '--name', 'st1', '--port', '4010', '--kinds', 'build,test'], { HOME: t })
    assert.equal(a.status, 0, a.stderr)
    const envf = path.join(p, 'etc/nightly-node/env')
    assert.equal(statSync(envf).mode & 0o777, 0o600)
    const text = readFileSync(envf, 'utf8')
    const token = /NIGHTLY_NODE_TOKEN=(\w+)/.exec(text)[1]
    assert.equal(token.length, 64)
    assert.match(text, /NIGHTLY_NODE_MODE=station/)
    assert.match(text, /NIGHTLY_NODE_KINDS=build,test/)
    assert.match(text, /ALLOW_USER_CREATE=false/)
    assert.ok(lstatSync(path.join(p, 'usr/local/bin/nightly-node')).isSymbolicLink())
    assert.ok(!existsSync(path.join(p, 'usr/local/bin/heavy')), 'a station gets no planet scripts')
    const b = sh(['--station', '--prefix', p, '--name', 'st1', '--port', '4010'], { HOME: t })
    assert.equal(b.status, 0, b.stderr)
    assert.match(readFileSync(envf, 'utf8'), new RegExp(`NIGHTLY_NODE_TOKEN=${token}`))
    assert.ok(!a.stdout.includes(token) && !b.stdout.includes(token), 'the token is never printed')
    const u = sh(['--uninstall', '--prefix', p], { HOME: t })
    assert.equal(u.status, 0, u.stderr)
    assert.ok(!existsSync(envf))
    assert.ok(!existsSync(path.join(p, 'usr/local/bin/nightly-node')))
})

test('install-node.sh: planet links the scripts and makes the account directory', () => {
    const t = tmp(), p = path.join(t, 'p')
    const r = sh(['--planet', '--prefix', p, '--name', 'pl'], { HOME: t })
    assert.equal(r.status, 0, r.stderr)
    for (const f of ['nightly-node', 'nightly', 'heavy', 'claude-acct']) assert.ok(lstatSync(path.join(p, 'usr/local/bin', f)).isSymbolicLink(), f)
    assert.ok(existsSync(path.join(t, '.claude-accounts')))
})

test('install-node.sh: bad arguments fail', () => {
    assert.notEqual(sh([]).status, 0)
    assert.notEqual(sh(['--station', '--port', '99999', '--dry-run']).status, 0)
    assert.notEqual(sh(['--station', '--panel', '--dry-run']).status, 0)
    assert.equal(sh(['--station', '--dry-run', '--prefix', path.join(tmp(), 'x')]).status, 0)
})

test('shellcheck is clean on the installer scripts', (t) => {
    if (spawnSync('shellcheck', ['--version']).status !== 0) return t.skip('shellcheck not installed')
    const r = spawnSync('shellcheck', ['install/install-node.sh', 'docker/entrypoint.sh', 'bin/nightly-node'], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.status, 0, r.stdout)
})

test('docker-compose.yml has the panel and clickhouse, the Dockerfile runs the bootstrap', () => {
    const c = readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8')
    assert.match(c, /^ {2}panel:/m)
    assert.match(c, /^ {2}clickhouse:/m)
    assert.match(c, /service_healthy/)
    assert.match(readFileSync(path.join(ROOT, 'docker/entrypoint.sh'), 'utf8'), /lib\/bootstrap\.mjs/)
    assert.match(readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'), /nightly-entrypoint/)
    const e = readFileSync(path.join(ROOT, '.env.example'), 'utf8')
    for (const k of ['NIGHTLY_ADMIN_USER', 'NIGHTLY_ADMIN_PASSWORD', 'NIGHTLY_EXTERNAL_HOST', 'NIGHTLY_INTERNAL_PORT', 'NIGHTLY_CLICKHOUSE_DB', 'NIGHTLY_CLICKHOUSE_USER', 'NIGHTLY_CLICKHOUSE_PASSWORD']) assert.match(e, new RegExp(`^${k}=`, 'm'), k)
})

test('discover registers the planet and the ssh boxes that match, with GPU kinds on staging', async () => {
    const t = tmp(), file = path.join(t, 'n.db')
    await bootstrap({ dbFile: file, env: { NIGHTLY_ADMIN_USER: 'a1', NIGHTLY_ADMIN_PASSWORD: 'pw-for-test-1' } })
    const cfg = path.join(t, 'ssh_config')
    writeFileSync(cfg, 'Host ph-box\n  HostName ph.example.net\n  User u\n\nHost staging9\n  HostName s9.example.net\n\nHost other\n  HostName o.example.net\n\nHost *\n  ForwardAgent no\n')
    const db = new DatabaseSync(file)
    const r = discoverBoxes(db, { configFile: cfg })
    assert.deepEqual(r.stations.map((s) => s.name).sort(), ['ph-box', 'staging9'])
    const again = discoverBoxes(db, { configFile: cfg })
    assert.ok(again.stations.every((s) => !s.created), 'second run creates nothing')
    const nodes = listNodes(db)
    assert.equal(nodes.filter((n) => n.type === 'planet').length, 1)
    const kinds = (n) => JSON.parse(nodes.find((x) => x.name === n).specs).offloadKinds
    assert.ok(kinds('staging9').includes('gpu'))
    assert.ok(!kinds('ph-box').includes('gpu'))
    assert.ok(!nodes.some((n) => n.name === 'other'))
    db.close()
})

test('db detect reads compose and .env, stores a secret reference and never the password', async () => {
    const t = tmp(), proj = path.join(t, 'proj'), file = path.join(t, 'n.db')
    mkdirSync(proj)
    writeFileSync(path.join(proj, '.env'), 'CH_PASSWORD=hunter2-secret\nCH_DB=events\n')
    writeFileSync(path.join(proj, 'docker-compose.yml'), 'services:\n  ch:\n    image: clickhouse/clickhouse-server:25.8\n    environment:\n      CLICKHOUSE_DB: ${CH_DB}\n      CLICKHOUSE_USER: app\n      CLICKHOUSE_PASSWORD: ${CH_PASSWORD}\n    ports:\n      - "18123:8123"\n  web:\n    image: nginx\n')
    assert.deepEqual(parseEnv('A=1\n# B=2\nexport C="x y"\n'), { A: '1', C: 'x y' })
    const found = detectCompose(proj)
    assert.equal(found.length, 1)
    assert.equal(found[0].kind, 'clickhouse')
    assert.equal(found[0].port, 18123)
    assert.equal(found[0].database, 'events')
    assert.equal(found[0].username, 'app')
    await bootstrap({ dbFile: file, env: { NIGHTLY_ADMIN_USER: 'a1', NIGHTLY_ADMIN_PASSWORD: 'pw-for-test-1' } })
    const db = new DatabaseSync(file)
    const r = await detectAndRegister(db, [proj])
    assert.equal(r.created.length, 1)
    assert.equal((await detectAndRegister(db, [proj])).created.length, 0)
    const row = db.prepare('SELECT * FROM DbConnection WHERE kind = ?').get('clickhouse')
    assert.ok(!JSON.stringify(row).includes('hunter2-secret'))
    assert.match(row.secretRef, /\.env:CLICKHOUSE_PASSWORD$/)
    db.close()
})
