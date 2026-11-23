// A neutral grey checker PNG, drawn for a material of an original map that has no texture file (so a missing texture reads as
// "missing", never as a hash or white placeholder colour). Pure Node: a tiny PNG writer over zlib.
import { deflateSync } from 'node:zlib'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 } return t })()
const crc32 = (b) => { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
const chunk = (type, data) => {
    const t = Buffer.from(type), len = Buffer.alloc(4), crc = Buffer.alloc(4)
    len.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
}

/** PNG bytes of a size x size two-tone grey checker with `cells` cells per side. */
export function checkerPng(size = 128, cells = 8) {
    const raw = Buffer.alloc(size * (size * 3 + 1)), step = size / cells
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const v = (Math.floor(x / step) + Math.floor(y / step)) & 1 ? 150 : 108, o = y * (size * 3 + 1) + 1 + x * 3
        raw[o] = raw[o + 1] = raw[o + 2] = v
    }
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

/** The checker file under dir (written once). */
export function checkerFile(dir) {
    const f = path.join(dir, 'no-texture-checker.png')
    if (!existsSync(f)) { mkdirSync(dir, { recursive: true }); writeFileSync(f, checkerPng()) }
    return f
}
