import path from 'node:path'

/** Model convention: a .glb (or .gltf) with the same base name beside a picture is that picture's 3D model. */
export const MODEL_EXT = ['.glb', '.gltf']

/** The sibling model of `file` among the directory's `files`, or null. */
export function modelSibling(files: string[], file: string): string | null {
    const base = file.slice(0, file.length - path.extname(file).length)
    return MODEL_EXT.map((e) => base + e).find((f) => files.includes(f)) ?? null
}
