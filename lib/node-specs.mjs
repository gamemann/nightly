// Hardware specs of this machine and ssh config parsing for the node registry. Shared by the CLI
// (lib/nodes.mjs) and the panel (src/server/nodesRouter.ts); no database handle here.
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'

export const NODE_TYPES = ['planet', 'station']
export const OFFLOAD_KINDS = ['build', 'test', 'suite', 'gpu', 'browser', 'perf', 'map-convert']
export const LINK_AUTH = ['ssh-key', 'password']
export const DB_KINDS = ['clickhouse', 'postgres', 'mysql', 'sqlite']

const sh = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 }); return r.status === 0 ? r.stdout : '' }

/** Probe this machine: cpu, ram, gpu, disks. Missing tools give empty fields, never an error. */
export function probeLocal() {
    const cpus = os.cpus()
    const info = (() => { try { return readFileSync('/proc/cpuinfo', 'utf8') } catch { return '' } })()
    const cores = new Set([...info.matchAll(/^physical id\s*:\s*(\d+)[\s\S]*?^core id\s*:\s*(\d+)/gm)].map((m) => `${m[1]}:${m[2]}`)).size || cpus.length
    const gpu = sh('lspci', []).split('\n').filter((l) => /VGA|3D controller|Display controller/i.test(l)).map((l) => l.replace(/^\S+\s+[^:]+:\s*/, '').trim())
    let disks = []
    try {
        disks = (JSON.parse(sh('lsblk', ['-J', '-d', '-b', '-o', 'NAME,SIZE,ROTA,MODEL,TYPE']) || '{}').blockdevices ?? [])
            .filter((d) => d.type === 'disk').map((d) => ({ name: d.name, gb: Math.round(Number(d.size) / 1e9), ssd: d.rota === false || d.rota === '0', model: (d.model ?? '').trim() }))
    } catch { disks = [] }
    return {
        cpu: { model: cpus[0]?.model?.trim() ?? '', mhz: cpus[0]?.speed ?? 0, cores, threads: cpus.length },
        ram: { gb: Math.round(os.totalmem() / 2 ** 30), type: '', mhz: 0 },
        gpu, disks,
        buildSlots: Math.max(1, Math.floor(cpus.length / 8)), heavySlots: 1,
        offloadKinds: ['build', 'test', 'suite'],
        os: `${os.type()} ${os.release()}`,
    }
}

/** Parse an ssh config into { alias: { hostname, user, port, identityFile } } (wildcard hosts skipped). */
export function parseSshConfig(text) {
    const out = {}
    let cur = []
    for (const raw of String(text).split('\n')) {
        const line = raw.replace(/#.*/, '').trim()
        if (!line) continue
        const m = /^([^\s=]+)\s*=?\s*(.*)$/.exec(line)
        if (!m) continue
        const k = m[1].toLowerCase(), v = m[2].trim()
        if (k === 'host') { cur = v.split(/\s+/).filter((h) => !/[*?!]/.test(h)); for (const h of cur) out[h] ??= {}; continue }
        if (k === 'match') { cur = []; continue }
        const key = { hostname: 'hostname', user: 'user', port: 'port', identityfile: 'identityFile' }[k]
        if (key) for (const h of cur) out[h][key] ??= key === 'port' ? Number(v) : v
    }
    return out
}

export function checkSpecs(specs) {
    const s = typeof specs === 'string' ? JSON.parse(specs || '{}') : specs ?? {}
    if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('specs: a JSON object')
    for (const k of ['buildSlots', 'heavySlots']) if (s[k] !== undefined && !(Number.isInteger(s[k]) && s[k] >= 0)) throw new Error(`specs.${k}: a whole number >= 0`)
    if (s.offloadKinds !== undefined && !(Array.isArray(s.offloadKinds) && s.offloadKinds.every((k) => OFFLOAD_KINDS.includes(k)))) throw new Error(`specs.offloadKinds: some of ${OFFLOAD_KINDS.join(', ')}`)
    return s
}
