export type DetectedDb = { name: string; kind: string; host: string; port: number; database: string; username: string; secretRef: string; file: string }
export function parseEnv(text: string): Record<string, string>
export function parseCompose(text: string): Record<string, { image: string; ports: string[]; env: Record<string, string> }>
export function detectCompose(dir: string): DetectedDb[]
export function detectAndRegister(db: unknown, dirs: string[]): Promise<{ created: string[]; existing: string[] }>
