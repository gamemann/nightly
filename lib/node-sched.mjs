// Offload routing: which node runs a job. Pure functions (no database, no sockets) so the panel, the CLI
// and the tests share them. A node descriptor: { id, name, type, online, enabled, specs: { offloadKinds,
// buildSlots, heavySlots, gpu: [] }, live: { slots: { build: {used,max}, heavy: {used,max} } } | null,
// reserved: { build, heavy } (jobs dispatched but not yet visible in live) }.
import path from 'node:path'
import { OFFLOAD_KINDS } from './node-specs.mjs'

const VIRTUAL_GPU = /virtio|vmware|qxl|cirrus|bochs|llvmpipe|1234:1111|basic render|microsoft/i
/** A real GPU: any listed adapter that is not a virtual one. */
export const hasGpu = (specs) => (specs?.gpu ?? []).some((g) => !VIRTUAL_GPU.test(String(g)))

/** GPU work: the `gpu` kind, or `browser` (WebGL) when the caller says it needs hardware GL. */
export const needsGpu = (kinds, { gpu = false } = {}) => gpu || kinds.includes('gpu')

const HEAVY = [
    [/\b(cargo|rustc)\s+(build|test|check|clippy)\b/, 'cargo'], [/\bgodot\b/i, 'godot'], [/\bgame\.sh\b/, 'game.sh'], [/\bnext\s+build\b|\bnpm run build\b|\bpnpm build\b/, 'web build'],
    [/\bdocker(?:\s+compose)?\s+build\b/, 'docker build'], [/\bmake\b.*-j\s*\d*/, 'parallel make'], [/\b(gradle|mvn)\b/, 'jvm build'], [/\bscripts?\/heavy\b|\bhv\b|\bheavy\s+--/, 'heavy tool'],
    [/\bplaywright\b|\bchromium\b/, 'browser'], [/\btsc\b(?!\s+--version)/, 'tsc'], [/\bblender\b|\bffmpeg\b/, 'media'],
]
/** Is this command heavy (many cores or lots of RAM)? An explicit flag wins; otherwise a command heuristic. */
export function detectHeavy(command, explicit) {
    if (explicit === true) return { heavy: true, reason: 'marked heavy' }
    for (const [re, why] of HEAVY) if (re.test(String(command ?? ''))) return { heavy: true, reason: why }
    return { heavy: false, reason: '' }
}

/** Offload kind of a command, when the build config does not name one. */
export function inferKinds(command) {
    const c = String(command ?? '')
    if (/playwright|chromium|webgl/i.test(c)) return ['browser']
    if (/perf|bench/i.test(c)) return ['perf']
    if (/map[-_ ]?conver|\bbsp\b/i.test(c)) return ['map-convert']
    if (/game\.sh\s+(--\S+\s+)*test|\bsuite\b/i.test(c)) return ['suite']
    if (/\b(test|vitest|jest|pytest)\b/i.test(c)) return ['test']
    return ['build']
}

const free = (n, heavy) => {
    const kind = heavy ? 'heavy' : 'build'
    const max = n.live?.slots?.[kind]?.max ?? (heavy ? n.specs?.heavySlots : n.specs?.buildSlots) ?? 0
    const used = (n.live?.slots?.[kind]?.used ?? 0) + (n.reserved?.[kind] ?? 0)
    return { max, used, free: max - used }
}

/**
 * Pick where a job runs. job: { kinds: [..], heavy, gpu }. Returns { node, why } with node null when none can
 * run it now; `capable` lists nodes that could once a slot frees (so the caller queues), empty when none ever can.
 * Stations come first; a planet is used only when opts.planetFallback (default true) and the job needs no GPU.
 */
export function pickNode(nodes, job, { planetFallback = true } = {}) {
    const kinds = (job.kinds?.length ? job.kinds : ['build']).filter((k) => OFFLOAD_KINDS.includes(k))
    const wantGpu = needsGpu(kinds, job)
    const reasons = []
    const capable = nodes.filter((n) => {
        if (n.enabled === false) return reasons.push(`${n.name}: disabled`), false
        if (!n.online) return reasons.push(`${n.name}: offline`), false
        if (n.type === 'planet' && (!planetFallback || wantGpu)) return reasons.push(`${n.name}: planet not used for this job`), false
        const offered = n.specs?.offloadKinds ?? []
        const miss = kinds.filter((k) => !offered.includes(k))
        if (miss.length) return reasons.push(`${n.name}: does not offer ${miss.join(', ')}`), false
        if (wantGpu && !hasGpu(n.specs)) return reasons.push(`${n.name}: no GPU`), false
        if (free(n, !!job.heavy).max <= 0) return reasons.push(`${n.name}: no ${job.heavy ? 'heavy' : 'build'} slots configured`), false
        return true
    })
    const open = capable.filter((n) => free(n, !!job.heavy).free > 0)
    if (!open.length) return { node: null, capable, why: capable.length ? 'every capable node is busy' : reasons.join('; ') || 'no nodes registered' }
    open.sort((a, b) => (a.type === b.type ? 0 : a.type === 'station' ? -1 : 1) || (free(b, !!job.heavy).free / free(b, !!job.heavy).max) - (free(a, !!job.heavy).free / free(a, !!job.heavy).max) || a.name.localeCompare(b.name))
    const best = open[0], f = free(best, !!job.heavy)
    return { node: best, capable, why: `${best.name}: ${f.free}/${f.max} ${job.heavy ? 'heavy' : 'build'} slots free` }
}

/**
 * Working directory of a project's job on a node. The node's own mapping wins (specs.projectPaths[slug]),
 * then <specs.workspace>/<repo folder name>, then the panel's repoPath (same layout on every machine).
 * '' when nothing is known; the caller then fails the job with a clear reason instead of guessing.
 */
export function nodeCwd(node, project) {
    const slug = project?.slug ?? '', repo = project?.repoPath ?? ''
    const mapped = node?.specs?.projectPaths?.[slug]
    if (slug && typeof mapped === 'string' && mapped) return mapped
    const ws = node?.specs?.workspace
    if (ws && (repo || slug)) return path.posix.join(ws, path.posix.basename(repo) || slug)
    return repo
}
