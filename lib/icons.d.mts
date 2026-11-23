export const ICON_MAX_BYTES: number
export function sniffImage(buf: Buffer): { ext: string; type: string } | null
export function iconFile(projectId: number, ext: string, now?: number): string
export function iconType(name: string | null | undefined): string | null
