// nightly-node configuration: a JSON file (NIGHTLY_NODE_CONFIG, default <state>/config.json) overlaid by
// environment variables (systemd's EnvironmentFile) and, last, by runtime overrides the panel sets
// (<state>/overrides.json: offload kinds and slots).
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OFFLOAD_KINDS } from '../lib/node-specs.mjs'
import { DEFAULT_PORT } from '../lib/node-proto.mjs'

const list = (v) => String(v ?? '').split(/[,\s]+/).filter(Boolean)
const int = (v, d) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : d }
const readJson = (f) => { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return {} } }

export function loadConfig(env = process.env) {
    const state = env.NIGHTLY_NODE_STATE || path.join(os.homedir(), '.nightly-node')
    mkdirSync(state, { recursive: true, mode: 0o700 })
    const file = env.NIGHTLY_NODE_CONFIG || path.join(state, 'config.json')
    const f = existsSync(file) ? readJson(file) : {}
    const o = readJson(path.join(state, 'overrides.json'))
    const tokens = list(env.NIGHTLY_NODE_TOKEN ?? f.token ?? (f.tokens ?? []).join(','))
    const kinds = list(env.NIGHTLY_NODE_KINDS ?? (f.kinds ?? []).join(','))
    const cfg = {
        state, file,
        name: env.NIGHTLY_NODE_NAME || f.name || os.hostname(),
        bind: env.NIGHTLY_NODE_BIND || f.bind || '0.0.0.0',
        port: int(env.NIGHTLY_NODE_PORT ?? f.port, DEFAULT_PORT),
        tlsCert: env.NIGHTLY_NODE_TLS_CERT || f.tlsCert || '',
        tlsKey: env.NIGHTLY_NODE_TLS_KEY || f.tlsKey || '',
        tokens,
        mode: env.NIGHTLY_NODE_MODE || f.mode || 'station',
        kinds: o.kinds ?? (kinds.length ? kinds : null), // null = whatever the hardware probe suggests
        buildSlots: o.buildSlots ?? (env.NIGHTLY_NODE_BUILD_SLOTS ?? f.buildSlots) ?? null,
        heavySlots: o.heavySlots ?? (env.NIGHTLY_NODE_HEAVY_SLOTS ?? f.heavySlots) ?? null,
        workspaces: list(env.NIGHTLY_NODE_WORKSPACES ?? (f.workspaces ?? []).join(',')),
        allowUserCreate: (env.NIGHTLY_NODE_ALLOW_USER_CREATE ?? String(f.allowUserCreate ?? 'true')) !== 'false',
        allowShell: (env.NIGHTLY_NODE_ALLOW_SHELL ?? String(f.allowShell ?? 'false')) === 'true',
        heartbeatMs: int(env.NIGHTLY_NODE_HEARTBEAT_MS ?? f.heartbeatMs, 10_000),
    }
    if (!cfg.workspaces.length) cfg.workspaces = [path.join(os.homedir(), 'workspaces'), '/tmp/nightly-node']
    if (cfg.kinds) cfg.kinds = cfg.kinds.filter((k) => OFFLOAD_KINDS.includes(k))
    return cfg
}

/** Persist runtime overrides from the panel (kinds, buildSlots, heavySlots). Returns the new overrides. */
export function saveOverrides(cfg, patch) {
    const f = path.join(cfg.state, 'overrides.json')
    const cur = readJson(f)
    if (patch.kinds !== undefined) {
        if (!Array.isArray(patch.kinds) || !patch.kinds.every((k) => OFFLOAD_KINDS.includes(k))) throw new Error(`kinds: some of ${OFFLOAD_KINDS.join(', ')}`)
        cur.kinds = patch.kinds
    }
    for (const k of ['buildSlots', 'heavySlots']) if (patch[k] !== undefined) {
        if (!Number.isInteger(patch[k]) || patch[k] < 0 || patch[k] > 256) throw new Error(`${k}: a whole number 0-256`)
        cur[k] = patch[k]
    }
    writeFileSync(f, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 })
    try { chmodSync(f, 0o600) } catch { /* best effort */ }
    Object.assign(cfg, cur)
    return cur
}
