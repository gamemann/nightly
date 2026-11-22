// Writes a synthetic Claude Code transcript tree (invented projects, no real text) for the README screenshot and manual trials.
//   node scripts/usage-demo-seed.mjs <dir> [days=21]   then   NIGHTLY_USAGE_DIRS=<dir> nightly usage ingest
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assistant, result } from '../lib/usage-fixture.mjs'

const [dir, daysArg] = process.argv.slice(2)
if (!dir) { console.error('usage: usage-demo-seed.mjs <dir> [days]'); process.exit(2) }
const days = Number(daysArg) || 21
let seed = 7
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
const pick = (a) => a[Math.floor(rnd() * a.length)]
const projects = ['storefront', 'game-server', 'docs-site']
const tools = ['Read', 'Bash', 'Edit', 'Grep', 'Bash', 'Read']
const end = Date.now() - (Date.now() % 3_600_000)
let n = 0
for (let d = days - 1; d >= 0; d--) {
    for (let s = 0; s < 2 + Math.floor(rnd() * 3); s++) {
        const proj = pick(projects), sess = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`
        let t = end - d * 86_400_000 - Math.floor(rnd() * 10) * 3_600_000
        const model = rnd() < 0.3 ? 'claude-opus-4-5' : rnd() < 0.8 ? 'claude-sonnet-4-5' : 'claude-haiku-4-5'
        const out = []
        const turns = 12 + Math.floor(rnd() * 40)
        let ctx = 15000
        for (let i = 0; i < turns; i++) {
            t += 20_000 + rnd() * 120_000
            const tool = pick(tools), id = `m${n}_${i}`
            ctx += Math.floor(rnd() * 2500)
            out.push(assistant({ id, ts: t, session: sess, model, cwd: `/work/${proj}`, input: 3 + Math.floor(rnd() * 20), output: 100 + Math.floor(rnd() * 1500), read: ctx, w5: rnd() < 0.2 ? Math.floor(rnd() * 8000) : 0, think: rnd() < 0.3 ? Math.floor(rnd() * 800) : 0, tools: [{ id: `tu_${id}`, name: tool, input: tool === 'Bash' ? { command: rnd() < 0.3 ? 'sleep 30; tail log' : 'npm test' } : { file_path: `src/f${Math.floor(rnd() * 6)}.ts` } }] }))
            out.push(result({ ts: t + 3000, session: sess, toolUseId: `tu_${id}`, text: 'x'.repeat(rnd() < 0.05 ? 90000 : 400 + Math.floor(rnd() * 6000)) }))
        }
        const pd = path.join(dir, `-work-${proj}`)
        mkdirSync(pd, { recursive: true })
        writeFileSync(path.join(pd, sess + '.jsonl'), out.join('\n') + '\n')
    }
}
console.log(`wrote ${n} sessions under ${dir}`)
