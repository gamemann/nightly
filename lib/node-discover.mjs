// Register the machines this operator already uses: this VM as the Planet, and the offload boxes found in
// ~/.ssh/config (aliases matching NIGHTLY_STATION_PATTERN, default ph-* and staging*) as Stations.
// GPU boxes (staging*) get the gpu/browser kinds; the others build/test/suite/perf. No credentials are read.
import { readFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import * as N from './nodes.mjs'
import { parseSshConfig } from './node-specs.mjs'

export const DEFAULT_PATTERN = '^(ph-|staging)'
const KINDS_GPU = ['build', 'test', 'suite', 'gpu', 'browser', 'perf']
const KINDS_CPU = ['build', 'test', 'suite', 'perf', 'map-convert']

export function discoverBoxes(db, { configFile = path.join(os.homedir(), '.ssh/config'), pattern = process.env.NIGHTLY_STATION_PATTERN || DEFAULT_PATTERN, planet = true } = {}) {
    const out = { planet: null, stations: [], skipped: [] }
    if (planet) out.planet = N.seedPlanet(db).name
    if (!existsSync(configFile)) return out
    const re = new RegExp(pattern, 'i')
    for (const alias of Object.keys(parseSshConfig(readFileSync(configFile, 'utf8')))) {
        if (alias.includes('*') || !re.test(alias)) continue
        try {
            const r = N.importSsh(db, alias, { configFile })
            const gpu = /staging|gpu/i.test(alias)
            const n = N.nodeRow(db, r.node.name)
            const specs = JSON.parse(n.specs || '{}')
            if (!specs.offloadKinds?.length) N.editNode(db, n.id, { specs: { ...specs, offloadKinds: gpu ? KINDS_GPU : KINDS_CPU, buildSlots: specs.buildSlots ?? 2, heavySlots: specs.heavySlots ?? 1 } })
            out.stations.push({ name: r.node.name, created: !!r.token, token: r.token })
        } catch (e) { out.skipped.push(`${alias}: ${e.message}`) }
    }
    return out
}
