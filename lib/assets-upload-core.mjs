// ASSET UPLOADS, pure part: what an uploaded file is (by extension and magic bytes), whether it is acceptable, and the size
// limit. No database, no disk: lib/assets-upload.test.mjs covers it directly.

/** Upload classes. `native`: the scan reads it as is; the others are converted (Blender) or stored as is. */
export const UPLOAD_TYPES = {
    model: { dir: 'models', exts: ['glb', 'gltf', 'obj', 'fbx', 'dae', 'stl', 'ply', 'blend'], native: ['glb', 'gltf'] },
    texture: { dir: 'textures', exts: ['png', 'jpg', 'jpeg', 'webp', 'tga', 'bmp', 'dds', 'ktx2', 'exr', 'hdr'], native: ['png', 'jpg', 'jpeg', 'webp'] },
    sound: { dir: 'sounds', exts: ['ogg', 'wav', 'mp3', 'flac', 'opus'], native: ['ogg', 'wav', 'mp3'] },
    animation: { dir: 'animations', exts: ['bvh', 'anim', 'smd'], native: [] },
    map: { dir: 'maps', exts: ['bsp', 'vmf', 'map', 'gma'], native: [] },
    other: { dir: 'other', exts: [], native: [] },
}
export const extOf = (name) => (/\.([A-Za-z0-9]+)$/.exec(String(name))?.[1] ?? '').toLowerCase()

/** The upload type of a file name. A .json is a map only when told so (see isMapManifest); `hint` forces a type. */
export function detectType(name, hint) {
    if (hint && UPLOAD_TYPES[hint]) return hint
    const e = extOf(name)
    for (const [t, d] of Object.entries(UPLOAD_TYPES)) if (t !== 'other' && d.exts.includes(e)) return t
    return 'other'
}

/** A safe file name: no directories, no control characters, no leading dot. */
export function safeName(name) {
    const base = String(name ?? '').split(/[\\/]/).pop().normalize('NFKC').replace(/[^\w.\- ()+]/g, '_').replace(/\s+/g, '_').replace(/^\.+/, '')
    if (!base || base.length > 160) throw new Error(`bad file name "${String(name).slice(0, 60)}"`)
    return base
}

const starts = (buf, s, at = 0) => buf.length >= at + s.length && Buffer.from(s, 'latin1').equals(buf.subarray(at, at + s.length))
/** Check the file's first bytes against its extension. Returns '' when fine or when there is no signature to check. */
export function checkMagic(name, buf) {
    const e = extOf(name)
    if (!buf?.length) return 'file is empty'
    const bad = (what) => `not a valid ${what} file`
    if (e === 'glb' && !starts(buf, 'glTF')) return bad('glb (missing glTF header)')
    if (e === 'gltf') { try { const j = JSON.parse(buf.toString('utf8')); if (!j.asset) return 'gltf has no "asset" block' } catch { return bad('gltf (not JSON)') } }
    if (e === 'png' && !starts(buf, '\x89PNG')) return bad('png')
    if ((e === 'jpg' || e === 'jpeg') && !(buf[0] === 0xff && buf[1] === 0xd8)) return bad('jpeg')
    if (e === 'webp' && !(starts(buf, 'RIFF') && starts(buf, 'WEBP', 8))) return bad('webp')
    if (e === 'wav' && !(starts(buf, 'RIFF') && starts(buf, 'WAVE', 8))) return bad('wav')
    if (e === 'ogg' && !starts(buf, 'OggS')) return bad('ogg')
    if (e === 'mp3' && !(starts(buf, 'ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return bad('mp3')
    if (e === 'bsp' && !['VBSP', 'rBSP', 'IBSP', 'BSP2', 'PSBV'].some((m) => starts(buf, m)) && !(buf.length > 4 && buf.readInt32LE(0) >= 17 && buf.readInt32LE(0) <= 40)) return bad('bsp (unknown BSP header)')
    if (e === 'fbx' && !(starts(buf, 'Kaydara FBX Binary') || /^\s*;\s*FBX/.test(buf.subarray(0, 64).toString('latin1')))) return bad('fbx')
    if (e === 'json') { try { JSON.parse(buf.toString('utf8')) } catch { return bad('JSON') } }
    return ''
}

/** A GameSpice map manifest (hand-built boxes definition, or a bsp-mesh manifest). */
export function isMapManifest(json) {
    if (!json || typeof json !== 'object') return false
    return /bsp-mesh$/.test(String(json.format ?? '')) || Array.isArray(json.boxes) || Array.isArray(json.surfaces) || Array.isArray(json.tiers)
}

/** The size limit in bytes: setting `uploadMaxMb` (and `uploadMaxMb.<type>`). 0 or empty = unlimited. */
export function limitBytes(settings, type) {
    const v = settings?.[`uploadMaxMb.${type}`] ?? settings?.uploadMaxMb
    const mb = v == null || v === '' ? 0 : Number(v)
    if (!Number.isFinite(mb) || mb < 0) throw new Error(`upload limit "${v}" must be a number of MB >= 0 (0 = unlimited)`)
    return Math.round(mb * 1048576)
}

/** Validate one file; throws a one-line reason. Returns { type, name, ext }. */
export function validateUpload({ name, bytes, buf, hint, settings = {} }) {
    const safe = safeName(name)
    const type = detectType(safe, hint)
    const ext = extOf(safe)
    if (type === 'other' && !hint) throw new Error(`${safe}: unknown file type ".${ext}" (models glb/gltf/obj/fbx/dae, textures png/jpg/webp, sounds ogg/wav/mp3, maps bsp/vmf/map/json; pass --type other to store it anyway)`)
    if (!bytes) throw new Error(`${safe}: file is empty`)
    const max = limitBytes(settings, type)
    if (max && bytes > max) throw new Error(`${safe}: ${(bytes / 1048576).toFixed(1)} MB is over the ${(max / 1048576).toFixed(0)} MB limit for ${type} uploads (setting uploadMaxMb, 0 = unlimited)`)
    if (buf) { const m = checkMagic(safe, buf); if (m) throw new Error(`${safe}: ${m}`) }
    return { type, name: safe, ext }
}
