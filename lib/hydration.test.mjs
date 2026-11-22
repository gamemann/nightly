import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

// Server (Node) and browser default locales differ, so a bare toLocaleString()/toLocaleDateString()/
// toLocaleTimeString() in a component rendered on the server gives React #418 on hydration.
const dir = new URL('../src/components/', import.meta.url)

test('components pass an explicit locale to toLocale*String', () => {
    const bad = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
        readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((line, i) => {
            if (/\.toLocale(Date|Time)?String\(\s*\)/.test(line)) bad.push(`${f}:${i + 1}`)
        })
    }
    assert.deepEqual(bad, [])
})

test('the asset thumbnail route answers 204, not 404, for a missing thumbnail', () => {
    const src = readFileSync(new URL('../src/app/api/assets/thumb/[id]/route.ts', import.meta.url), 'utf8')
    assert.match(src, /status: 204/)
    assert.doesNotMatch(src, /status: 404/)
})

// React renders an SVG <title> with several children (text and expressions) as an empty element on the
// server but fills it on the client: React #418. A title needs one string child.
test('svg <title> elements have a single string child', () => {
    const bad = []
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.tsx'))) {
        readFileSync(new URL(f, dir), 'utf8').split('\n').forEach((line, i) => {
            for (const m of line.matchAll(/<title>(.*?)<\/title>/g)) if (!/^\{`[^`]*`\}$/.test(m[1]) && !/^\{[\w.]+\}$/.test(m[1]) && !/^[^{}<]*$/.test(m[1])) bad.push(`${f}:${i + 1}`)
        })
    }
    assert.deepEqual(bad, [])
})
