export function renderLine(line: string): { role: 'user' | 'assistant'; kind: string; ts: string; model?: string; meta?: boolean; blocks: any[]; launched?: string; uuid: string } | null
