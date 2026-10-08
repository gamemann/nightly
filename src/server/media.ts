import path from 'node:path'

/** Where run screenshots live: <dir>/<YYYY-MM-DD>/… (the private archive/ repo by default). */
// Read at run time, never bundled: without the ignore, Turbopack traces the whole project into the build.
export const MEDIA_DIR = path.resolve(/*turbopackIgnore: true*/ process.env.NIGHTLY_MEDIA || path.join(process.cwd(), 'archive', 'screenshots'))

export const MEDIA_EXT: Record<string, string> = {
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
    '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
}
