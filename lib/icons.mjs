// Project icons: an uploaded image is sniffed by its magic bytes (never by the name or the browser's
// content type) and stored as <projectId>-<time>.<ext>. SVG is refused: it can carry script.

/** Largest icon accepted, in bytes. */
export const ICON_MAX_BYTES = 512 * 1024

const SIGS = [
    { ext: 'png', type: 'image/png', test: (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
    { ext: 'jpg', type: 'image/jpeg', test: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
    { ext: 'gif', type: 'image/gif', test: (b) => b.length > 6 && b.subarray(0, 4).toString('latin1') === 'GIF8' },
    { ext: 'webp', type: 'image/webp', test: (b) => b.length > 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
]

/** { ext, type } for an accepted image buffer, or null. */
export function sniffImage(buf) {
    const s = SIGS.find((x) => x.test(buf))
    return s ? { ext: s.ext, type: s.type } : null
}

/** The stored file name for a project's icon. */
export const iconFile = (projectId, ext, now = Date.now()) => `${projectId}-${now}.${ext}`

/** A stored icon name we wrote ourselves (no path parts), with its content type; null otherwise. */
export function iconType(name) {
    const m = /^\d+-\d+\.(png|jpg|gif|webp)$/.exec(name ?? '')
    return m ? SIGS.find((s) => s.ext === m[1]).type : null
}
