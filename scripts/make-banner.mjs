#!/usr/bin/env node
// Renders docs/banner.html to a 1280x640 PNG (GitHub's social preview size) with Playwright's Chromium.
//   node scripts/make-banner.mjs [--badge "env & scripts"] [--tagline TEXT] [--foot TEXT] [--out docs/banner.png]
// Playwright is not a dependency of this repo: set PLAYWRIGHT_MODULE to a playwright(-core) package directory,
// or have it resolvable from NODE_PATH / the current directory. CHROMIUM=/path picks a browser binary.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { statSync } from 'node:fs'

const args = process.argv.slice(2)
const opt = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
if (args.includes('--help')) { console.log('usage: make-banner.mjs [--badge T] [--tagline T] [--foot T] [--out FILE]'); process.exit(0) }
const here = dirname(fileURLToPath(import.meta.url))
const out = resolve(opt('out', resolve(here, '../docs/banner.png')))
const require = createRequire(import.meta.url)
const mod = process.env.PLAYWRIGHT_MODULE || (() => { for (const m of ['playwright', 'playwright-core']) { try { return require.resolve(m, { paths: [process.cwd(), ...(process.env.NODE_PATH || '').split(':').filter(Boolean)] }) } catch {} } })()
if (!mod) { console.error('playwright not found: set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright'); process.exit(2) }
const { chromium } = require(mod)
const q = new URLSearchParams()
for (const k of ['badge', 'tagline', 'foot']) if (args.includes('--' + k)) q.set(k, opt(k))
const url = pathToFileURL(resolve(here, '../docs/banner.html')).href + (q.size ? '?' + q : '')
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined })
const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 })
await page.goto(url)
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1280, height: 640 } })
await browser.close()
console.log(`${out} ${statSync(out).size} bytes`)
