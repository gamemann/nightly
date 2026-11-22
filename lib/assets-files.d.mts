export type AssetFile = { file: string; mime?: string; bytes?: undefined } | { bytes: Buffer; mime: string; file?: undefined }
export function setExtraRoots(roots: string[]): void
export function resolveFile(data: Record<string, unknown>, kind: string, i?: number): AssetFile | null
export function underRoots(file: string): boolean
export function AUDIT_DIR(): string
