// Batch image downscaler for the map converter (run as a child process so the converter itself stays synchronous):
// node map-tex-worker.mjs <jobs.json>   jobs = [{ in, out, max, format, quality }]
// Prints JSON { error? , results: [{ out, w, h, error? }] } on stdout. Needs the `sharp` package.
import { readFileSync, writeFileSync } from 'node:fs'
let sharp
try { sharp = (await import('sharp')).default } catch (e) { console.log(JSON.stringify({ error: `sharp is not installed: ${e.message}`, results: [] })); process.exit(0) }
sharp.cache(false); sharp.concurrency(2)
const jobs = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const results = new Array(jobs.length)
let next = 0
async function lane() {
    while (next < jobs.length) {
        const i = next++, j = jobs[i]
        try {
            let img = sharp(j.in, { failOn: 'none', limitInputPixels: false }).resize({ width: j.max, height: j.max, fit: 'inside', withoutEnlargement: true })
            const q = j.quality ?? 80
            img = j.format === 'png' ? img.png({ compressionLevel: 9 }) : j.format === 'jpg' ? img.jpeg({ quality: q }) : img.webp({ quality: q })
            const info = await img.toFile(j.out)
            results[i] = { out: j.out, w: info.width, h: info.height }
        } catch (e) { results[i] = { out: j.out, error: String(e.message ?? e).slice(0, 200) } }
    }
}
await Promise.all([lane(), lane(), lane()])
console.log(JSON.stringify({ results }))
