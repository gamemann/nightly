// Review items (kind "review"): per-weapon before/after filmstrips and clips, audio with waveform and
// licence, and a good / still-wrong verdict with a note. Files plus review.json per item under
// NIGHTLY_REVIEWS (default data/reviews/<key>/), no schema change. The panel and the CLI share this module.
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..")
export const REVIEW_DIR = path.resolve(process.env.NIGHTLY_REVIEWS || path.join(ROOT, "data", "reviews"))
export const SLOTS = ["filmstrip", "clip", "audio", "image", "screenshot"]
export const VARIANTS = ["before", "after", ""]
export const VERDICTS = ["good", "wrong"]
export const MAX_BYTES = 12 * 1024 * 1024
export const TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
    ".mp4": "video/mp4", ".webm": "video/webm", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp3": "audio/mpeg",
}

const safe = (s) => String(s).replace(/[^\w.-]/g, "_").slice(0, 80)
const dirFor = (key) => path.join(REVIEW_DIR, safe(key))
const baseUrl = () => (process.env.NIGHTLY_PUBLIC_URL || `http://${os.hostname()}:3010`).replace(/\/$/, "")
export const urlFor = (key, file) => `${baseUrl()}/reviewmedia/${encodeURIComponent(safe(key))}/${file.split("/").map(encodeURIComponent).join("/")}`

export function load(key) {
    try { return JSON.parse(readFileSync(path.join(dirFor(key), "review.json"), "utf8")) } catch { return { weapons: {} } }
}

function save(key, data) {
    const d = dirFor(key)
    mkdirSync(d, { recursive: true })
    const tmp = path.join(d, "review.json.tmp")
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, path.join(d, "review.json"))
}

function weapon(data, id, title) {
    const w = (data.weapons[id] ??= { title: title || id, media: [], verdict: "", note: "", by: "", at: "", history: [] })
    if (title) w.title = title
    return w
}

/** Store a media file for a weapon. Audio gets a waveform PNG (the given one, else ffmpeg's). Replaces a same-named file. */
export function addMedia(key, weaponId, src, { slot, variant = "", label = "", licence = "", source = "", note = "", title = "", waveform = "", by = "session", look = "", metrics = null, entryLook = "", entryMetrics = null } = {}) {
    if (!SLOTS.includes(slot)) throw new Error(`bad slot "${slot}" (one of: ${SLOTS.join(", ")})`)
    if (!VARIANTS.includes(variant)) throw new Error(`bad variant "${variant}" (before, after or empty)`)
    const ext = path.extname(src).toLowerCase()
    if (!TYPES[ext]) throw new Error(`unsupported file type ${ext}`)
    if ((slot === "audio") !== TYPES[ext].startsWith("audio/")) throw new Error(`slot ${slot} does not take ${ext}`)
    if (!existsSync(src)) throw new Error(`no such file: ${src}`)
    if (statSync(src).size > MAX_BYTES) throw new Error(`file over ${MAX_BYTES / 1024 / 1024} MB`)
    const w = safe(weaponId)
    const dir = path.join(dirFor(key), w)
    mkdirSync(dir, { recursive: true })
    const stem = [slot, variant, safe(label || path.basename(src, ext))].filter(Boolean).join("_")
    const file = `${stem}${ext}`
    copyFileSync(src, path.join(dir, file))
    const m = { slot, variant, label: label || path.basename(src, ext), file: `${w}/${file}`, licence, source, note, by, at: new Date().toISOString() }
    if (look) m.look = String(look).slice(0, 300)
    const mm = cleanMetrics(metrics)
    if (mm) m.metrics = mm
    if (/^video\//.test(TYPES[ext])) Object.assign(m, videoDerived(path.join(dir, file), dir, stem, w))
    if (slot === "audio") {
        const wf = path.join(dir, `${stem}.wave.png`)
        if (waveform && existsSync(waveform) && path.extname(waveform).toLowerCase() === ".png") copyFileSync(waveform, wf)
        else spawnSync("ffmpeg", ["-y", "-v", "error", "-i", src, "-filter_complex", "showwavespic=s=900x120:colors=#5eead4", "-frames:v", "1", wf], { encoding: "utf8" })
        if (existsSync(wf)) m.waveform = `${w}/${stem}.wave.png`
    }
    const data = load(key)
    const entry = weapon(data, w, title)
    if (entryLook) entry.look = String(entryLook).slice(0, 300)
    const em = cleanMetrics(entryMetrics)
    if (em) entry.metrics = { ...(entry.metrics ?? {}), ...em }
    entry.media = entry.media.filter((x) => x.file !== m.file).concat(m)
    save(key, data)
    return { ...m, url: urlFor(key, m.file) }
}

/** Measured numbers beside a media item: {name: value}, scalar values (a JSON string is accepted). */
function cleanMetrics(v) {
    if (typeof v === "string" && v.trim()) { try { v = JSON.parse(v) } catch { return null } }
    if (!v || typeof v !== "object" || Array.isArray(v)) return null
    const out = {}
    for (const [k, x] of Object.entries(v).slice(0, 24)) if (["string", "number", "boolean"].includes(typeof x)) out[String(k).slice(0, 40)] = typeof x === "string" ? x.slice(0, 80) : x
    return Object.keys(out).length ? out : null
}

/** Poster frame, 8-frame strip (jpg, 8 tiles of 320 px) and size/duration of a video, made with ffmpeg so the page can show a still, scrub and step. */
function videoDerived(file, dir, stem, w) {
    const out = {}
    const pr = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=width,height,r_frame_rate", "-of", "json", file], { encoding: "utf8" })
    let dur = 0
    try {
        const j = JSON.parse(pr.stdout || "{}")
        dur = Number(j.format?.duration) || 0
        const st = j.streams?.[0]
        if (st?.width) { out.width = st.width; out.height = st.height }
        const [a, b] = String(st?.r_frame_rate ?? "").split("/").map(Number)
        if (a && b) out.fps = Math.round((a / b) * 10) / 10
    } catch { /* no ffprobe: the page still plays the video */ }
    if (dur) out.duration = Math.round(dur * 100) / 100
    const poster = path.join(dir, `${stem}.poster.jpg`)
    spawnSync("ffmpeg", ["-y", "-v", "error", "-ss", String(Math.min(0.2, dur / 2)), "-i", file, "-frames:v", "1", "-q:v", "3", poster], { encoding: "utf8" })
    if (existsSync(poster)) out.poster = `${w}/${stem}.poster.jpg`
    const strip = path.join(dir, `${stem}.strip.jpg`)
    if (dur > 0) spawnSync("ffmpeg", ["-y", "-v", "error", "-i", file, "-vf", `fps=8/${dur},scale=320:-2,tile=8x1`, "-frames:v", "1", "-q:v", "4", strip], { encoding: "utf8" })
    if (existsSync(strip)) out.strip = `${w}/${stem}.strip.jpg`
    return out
}

/** Record the latest verdict (good | wrong) and note; earlier verdicts stay in history. */
export function setVerdict(key, weaponId, verdict, { note = "", by = "christian" } = {}) {
    if (!VERDICTS.includes(verdict) && verdict !== "") throw new Error(`bad verdict "${verdict}" (good, wrong, or empty to clear)`)
    const data = load(key)
    const w = weapon(data, safe(weaponId))
    const at = new Date().toISOString()
    if (w.verdict || w.note) w.history = [...(w.history ?? []), { verdict: w.verdict, note: w.note, by: w.by, at: w.at }].slice(-20)
    Object.assign(w, { verdict, note, by, at })
    save(key, data)
    return { weapon: safe(weaponId), verdict, note, by, at }
}

/** Resolve a /reviewmedia path to a file on disk, or null when it escapes the item's directory or is not media. */
export function mediaPath(key, parts) {
    const base = dirFor(key)
    const file = path.resolve(base, ...parts)
    if (!file.startsWith(base + path.sep) || !TYPES[path.extname(file).toLowerCase()]) return null
    return file
}

/** Weapons not yet marked good: what a builder still has to fix or get reviewed. */
export function open(key) {
    const data = load(key)
    return Object.entries(data.weapons).filter(([, w]) => w.verdict !== "good").map(([id, w]) => ({ weapon: id, title: w.title, verdict: w.verdict || "unreviewed", note: w.note }))
}
