export type Block =
    | { type: 'text'; text: string }
    | { type: 'thinking'; text: string; redacted?: boolean }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; id: string; text: string; isError?: boolean; cut?: number; images?: number }
    | { type: 'image' }

export type Entry = { seq: number; uuid: string; role: 'user' | 'assistant'; kind: string; ts: string; model?: string; meta?: boolean; blocks: Block[]; launched?: string }

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const MODES = [
    ['default', 'Ask first', 'Tools that need approval are denied in print mode'],
    ['acceptEdits', 'Accept edits', 'File edits go through without asking'],
    ['plan', 'Plan', 'Read-only planning, no changes'],
    ['auto', 'Auto', 'A classifier approves safe actions'],
    ['bypass', 'Bypass', 'Everything runs without asking. Use in a throwaway directory only'],
] as const
export const MODELS = [['', 'Default'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']] as const

export const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n))
export const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
export const baseName = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p
