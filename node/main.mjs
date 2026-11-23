// Entry point of nightly-node (see bin/nightly-node).
import { startDaemon, VERSION } from './daemon.mjs'
import { detectSpecs } from '../lib/node-probe.mjs'
import { newToken } from '../lib/node-proto.mjs'
import { loadConfig } from './config.mjs'

const cmd = process.argv[2] ?? 'run'
if (cmd === 'version' || cmd === '--version') console.log(VERSION)
else if (cmd === 'token') console.log(newToken())
else if (cmd === 'specs') console.log(JSON.stringify(detectSpecs(), null, 2))
else if (cmd === 'run') {
    try {
        const d = await startDaemon(loadConfig())
        const bye = () => { d.stop(); setTimeout(() => process.exit(0), 300).unref() }
        process.on('SIGTERM', bye); process.on('SIGINT', bye)
    } catch (e) { console.error(`nightly-node: ${e.message}`); process.exit(1) }
} else { console.error('usage: nightly-node [run|specs|token|version]'); process.exit(2) }
