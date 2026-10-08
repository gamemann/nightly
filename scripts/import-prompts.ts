// One-off import of a directory of prompt files (*.md) and runner scripts (*.sh) into the
// Prompt table. If the directory is a Git repository, each file's history comes along as
// PromptVersion rows (one per commit that changed it, dated and noted with the commit),
// then the working tree's text, committed or not, becomes the current body.
// Safe to re-run: a body equal to the current one records nothing.
// Usage: node --no-warnings scripts/import-prompts.ts DIR
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import * as P from '../lib/prompts.mjs'
import * as S from '../lib/store.mjs'

const dir = process.argv[2] ?? (console.error('usage: import-prompts.ts DIR'), process.exit(1))
const git = existsSync(path.join(dir, '.git'))
const run = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 })

const db = S.open()
for (const name of readdirSync(dir).filter((f) => /\.(md|sh)$/.test(f)).sort()) {
    const kind = name.endsWith('.sh') ? 'script' : 'prompt'
    // An import that runs again after the prompt was edited here must not roll it back.
    if (P.get(db, name) && !process.argv.includes('--force')) { console.log(`${name}: already in the database, skipped`); continue }
    let versions = 0
    if (git) {
        const log = run('log', '--reverse', '--format=%H%x09%aI%x09%s', '--', name).trim()
        for (const line of log ? log.split('\n') : []) {
            const [sha, date, subject] = line.split('\t')
            let body: string
            try { body = run('show', `${sha}:${name}`) } catch { continue }   // deleted in that commit
            if (P.set(db, name, body, { kind, author: 'import', note: `${sha.slice(0, 7)} ${subject}`, at: new Date(date).toISOString() }).changed) versions++
        }
    }
    const current = readFileSync(path.join(dir, name), 'utf8')
    if (P.set(db, name, current, { kind, author: 'import', note: 'working tree at import' }).changed) versions++
    console.log(`${name}: ${versions} version${versions === 1 ? '' : 's'}`)
}
