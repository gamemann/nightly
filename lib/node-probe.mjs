// Hardware detection for a node, beyond lib/node-specs.mjs probeLocal(): CPU speeds from lscpu, RAM type and
// speed from dmidecode (needs root; tried directly then through `sudo -n`, best effort), GPUs with memory from
// nvidia-smi or lspci. Every missing tool leaves its field empty, never an error.
import { spawnSync } from 'node:child_process'
import { probeLocal } from './node-specs.mjs'

const run = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 6000 }); return r.status === 0 ? r.stdout : '' }

export function parseLscpu(text) {
    const o = {}
    for (const l of String(text).split('\n')) { const i = l.indexOf(':'); if (i > 0) o[l.slice(0, i).trim()] = l.slice(i + 1).trim() }
    const num = (k) => Number(String(o[k] ?? '').replace(/[^\d.]/g, '')) || 0
    return { model: o['Model name'] ?? '', maxMhz: Math.round(num('CPU max MHz')), mhz: Math.round(num('CPU MHz')), sockets: num('Socket(s)'), coresPerSocket: num('Core(s) per socket'), threadsPerCore: num('Thread(s) per core') }
}

/** dmidecode -t memory output -> { type, mhz, sticks, gb } from the populated slots. */
export function parseDmiMemory(text) {
    const devs = String(text).split(/\n\n(?=Handle )/).filter((b) => /Memory Device/.test(b) && /Size: \d/.test(b))
    let gb = 0, type = '', mhz = 0
    for (const b of devs) {
        const size = /Size:\s*(\d+)\s*(MB|GB)/.exec(b)
        if (size) gb += size[2] === 'GB' ? Number(size[1]) : Number(size[1]) / 1024
        const t = /\n\s*Type:\s*(DDR\d?\w*|LPDDR\d\w*)/.exec(b); if (t && !type) type = t[1]
        const s = /Configured (?:Memory|Clock) Speed:\s*(\d+)/.exec(b) ?? /\n\s*Speed:\s*(\d+)\s*(?:MT\/s|MHz)/.exec(b)
        if (s && !mhz) mhz = Number(s[1])
    }
    return { type, mhz, sticks: devs.length, gb: Math.round(gb) }
}

export function parseNvidiaSmi(text) {
    return String(text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, mem] = l.split(',').map((x) => x.trim())
        return `${name}${mem ? ` (${mem})` : ''}`
    })
}

function dmi() {
    for (const [c, a] of [['dmidecode', ['-t', 'memory']], ['sudo', ['-n', 'dmidecode', '-t', 'memory']]]) {
        const out = run(c, a)
        if (out) return parseDmiMemory(out)
    }
    return null
}

/** The full probe. Same shape as probeLocal(), plus cpu.maxMhz/sockets, ram.type/mhz when known, gpu entries with VRAM. */
export function detectSpecs() {
    const s = probeLocal()
    const l = parseLscpu(run('lscpu', []))
    if (l.model && !s.cpu.model) s.cpu.model = l.model
    s.cpu.mhz = l.maxMhz || l.mhz || s.cpu.mhz
    s.cpu.maxMhz = l.maxMhz; s.cpu.sockets = l.sockets || 1
    if (l.sockets && l.coresPerSocket) s.cpu.cores = l.sockets * l.coresPerSocket
    const d = dmi()
    if (d) { s.ram.type = d.type; s.ram.mhz = d.mhz; if (d.gb) s.ram.gb = d.gb }
    const nv = parseNvidiaSmi(run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader']))
    if (nv.length) s.gpu = nv
    const hasGpu = s.gpu.some((g) => /nvidia|amd|radeon|geforce|rtx|gtx/i.test(g)) && !s.gpu.every((g) => /virtio|vmware|qxl|cirrus|bochs|llvmpipe/i.test(g))
    s.offloadKinds = [...new Set([...s.offloadKinds, ...(hasGpu ? ['gpu', 'browser'] : [])])]
    return s
}
