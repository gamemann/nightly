'use client'
import { useState, type ReactNode } from 'react'
import { Markdown } from '~/components/Markdown'
import { api } from '~/trpc/react'
import { baseName, short, tokens, type Block, type Entry } from './types'

type ToolUse = Extract<Block, { type: 'tool_use' }>
type ToolResult = Extract<Block, { type: 'tool_result' }>
export type Child = { id: number; toolUseId?: string; agentId: string; agentType: string; description: string; messageCount: number; toolCount: number; outTokens: number; status: string }

const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v))

/** Short one-line summary of a tool call for the collapsed card header. */
function summary(b: ToolUse): string {
    const i = b.input
    switch (b.name) {
        case 'Bash': return short(str(i.description) || str(i.command), 110)
        case 'Read': case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': return str(i.file_path || i.notebook_path)
        case 'Glob': case 'Grep': return short(str(i.pattern) + (i.path ? `  in ${str(i.path)}` : ''), 110)
        case 'WebFetch': return str(i.url)
        case 'WebSearch': return str(i.query)
        case 'Agent': case 'Task': return short(str(i.description) || str(i.prompt), 110)
        case 'TodoWrite': return `${Array.isArray(i.todos) ? i.todos.length : 0} items`
        default: return short(Object.values(i).map(str).find((x) => x) ?? '', 110)
    }
}

const COLORS: Record<string, string> = { Bash: 'text-amber-300', Read: 'text-sky-300', Grep: 'text-sky-300', Glob: 'text-sky-300', Edit: 'text-emerald-300', Write: 'text-emerald-300', MultiEdit: 'text-emerald-300', Agent: 'text-accent', Task: 'text-accent', TodoWrite: 'text-teal-300' }

/** Line diff of old -> new text: common prefix and suffix trimmed, the middle shown as removed then added. Edit hunks are small. */
export function Diff({ a, b }: { a: string; b: string }) {
    const x = a.split('\n'), y = b.split('\n')
    let s = 0
    while (s < x.length && s < y.length && x[s] === y[s]) s++
    let e = 0
    while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++
    const ctx = (l: string[], at: number, n: number) => l.slice(Math.max(0, at - n), at)
    const rows: [string, string][] = [
        ...ctx(x, s, 2).map((l): [string, string] => [' ', l]),
        ...x.slice(s, x.length - e).map((l): [string, string] => ['-', l]),
        ...y.slice(s, y.length - e).map((l): [string, string] => ['+', l]),
        ...x.slice(x.length - e, x.length - e + 2).map((l): [string, string] => [' ', l]),
    ]
    return (
        <pre className="max-h-96 overflow-auto rounded-md border border-line bg-bg py-1 font-mono text-[12px] leading-5">
            {rows.map(([k, l], n) => (
                <div key={n} className={k === '+' ? 'bg-emerald-500/10 text-emerald-200' : k === '-' ? 'bg-red-500/10 text-red-200' : 'text-muted'}>
                    <span className="inline-block w-5 select-none text-center opacity-60">{k}</span>{l || ' '}
                </div>
            ))}
        </pre>
    )
}

function Todos({ todos }: { todos: unknown }) {
    const list = Array.isArray(todos) ? (todos as { content?: string; status?: string }[]) : []
    return (
        <ul className="space-y-0.5 py-1">
            {list.map((t, n) => (
                <li key={n} className="flex items-start gap-2 text-[12px]">
                    <span className={t.status === 'completed' ? 'text-emerald-400' : t.status === 'in_progress' ? 'text-amber-300' : 'text-muted'}>{t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}</span>
                    <span className={t.status === 'completed' ? 'text-muted line-through' : 'text-fg'}>{t.content}</span>
                </li>
            ))}
        </ul>
    )
}

function Pre({ children, tone }: { children: string; tone?: 'error' }) {
    return <pre className={`max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-bg p-2 font-mono text-[12px] leading-5 ${tone === 'error' ? 'text-red-200' : 'text-dim'}`}>{children}</pre>
}

function Body({ b }: { b: ToolUse }) {
    const i = b.input
    if (b.name === 'Edit') return <Diff a={str(i.old_string)} b={str(i.new_string)} />
    if (b.name === 'MultiEdit' && Array.isArray(i.edits)) return <div className="space-y-2">{(i.edits as { old_string?: string; new_string?: string }[]).map((e, n) => <Diff key={n} a={str(e.old_string)} b={str(e.new_string)} />)}</div>
    if (b.name === 'Write') return <Diff a="" b={str(i.content)} />
    if (b.name === 'Bash') return <Pre>{`$ ${str(i.command)}`}</Pre>
    if (b.name === 'TodoWrite') return <Todos todos={i.todos} />
    if (b.name === 'Agent' || b.name === 'Task') return <Markdown>{str(i.prompt)}</Markdown>
    return <Pre>{JSON.stringify(i, null, 2)}</Pre>
}

/** One tool call with its result, collapsed to a line. An Agent call also embeds the subagent's own thread. */
export function ToolCard({ use, result, child }: { use: ToolUse; result?: ToolResult; child?: Child }) {
    const [open, setOpen] = useState(use.name === 'TodoWrite' || use.name === 'Edit' || use.name === 'Write' || use.name === 'MultiEdit' ? false : false)
    const err = result?.isError
    return (
        <div className={`my-1.5 rounded-lg border ${err ? 'border-red-500/30' : 'border-line'} bg-panel/70`}>
            <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12px]">
                <span className={`text-[10px] text-muted transition ${open ? 'rotate-90' : ''}`}>▶</span>
                <span className={`font-mono font-medium ${COLORS[use.name] ?? 'text-dim'}`}>{use.name}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-muted">{summary(use)}</span>
                {child && <span className="shrink-0 rounded bg-accent/15 px-1.5 text-[10px] text-accent">{child.messageCount} msgs · {tokens(child.outTokens)} out</span>}
                {result ? <span className={`shrink-0 text-[11px] ${err ? 'text-red-300' : 'text-emerald-400'}`}>{err ? 'error' : '✓'}</span> : <span className="shrink-0 animate-pulse text-[11px] text-amber-300">running</span>}
            </button>
            {open && (
                <div className="space-y-2 border-t border-line px-2.5 py-2">
                    <Body b={use} />
                    {result && result.text && (
                        <div>
                            <div className="label mb-1">Result{result.cut ? ` (${result.cut} more characters not shown)` : ''}</div>
                            <Pre tone={err ? 'error' : undefined}>{result.text}</Pre>
                        </div>
                    )}
                    {!!result?.images && <div className="text-[11px] text-muted">{result.images} image(s) in the result</div>}
                </div>
            )}
            {child && <SubThread child={child} />}
        </div>
    )
}

/** The nested thread of a subagent: loaded when first opened, rendered with the same blocks. */
function SubThread({ child }: { child: Child }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="border-t border-line">
            <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-2.5 py-1 text-left text-[11px] text-accent hover:bg-hover/50">
                <span className={`text-[9px] transition ${open ? 'rotate-90' : ''}`}>▶</span>
                <span>{child.agentType || 'subagent'} thread</span><span className="text-muted">{child.toolCount} tool calls</span>
                {child.status === 'running' && <span className="animate-pulse text-amber-300">running</span>}
            </button>
            {open && <div className="ml-3 border-l border-accent/30 pl-2 pb-1"><Thread id={child.id} depth={1} /></div>}
        </div>
    )
}

function Thread({ id, depth }: { id: number; depth: number }) {
    const q = api.transcripts.messages.useQuery({ id, limit: 120 }, { refetchInterval: 4000 })
    const tree = api.transcripts.tree.useQuery({ id }, { staleTime: 10_000 })
    if (!q.data) return <div className="py-2 text-[11px] text-muted">loading…</div>
    const kids = (tree.data?.nodes ?? []).filter((n) => n.parentId === id) as unknown as (Child & { toolUseId?: string })[]
    return (
        <div>
            {q.data.hasMore && <div className="py-1 text-[11px] text-muted">earlier entries not shown, open the thread on its own page for all of it</div>}
            <Entries entries={q.data.entries as Entry[]} children={kids} depth={depth} />
        </div>
    )
}

function Thinking({ text, redacted }: { text: string; redacted?: boolean }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="my-1 text-[12px]">
            <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-muted hover:text-dim">
                <span className={`text-[9px] transition ${open ? 'rotate-90' : ''}`}>▶</span><span className="italic">{redacted ? 'thinking (not shown)' : 'thinking'}</span>
            </button>
            {open && !redacted && <div className="mt-1 whitespace-pre-wrap border-l border-line-strong pl-3 italic text-muted">{text}</div>}
        </div>
    )
}

/** A conversation: assistant text as Markdown, tool calls paired with their results, a user turn as a bubble. */
export function Entries({ entries, children = [], depth = 0, live }: { entries: Entry[]; children?: Child[]; depth?: number; live?: ReactNode }) {
    const results = new Map<string, ToolResult>()
    for (const e of entries) for (const b of e.blocks) if (b.type === 'tool_result') results.set(b.id, b)
    const byUse = new Map(children.filter((c) => c.toolUseId).map((c) => [c.toolUseId as string, c]))
    const byAgent = new Map(children.map((c) => [c.agentId, c]))
    const launched = new Map<string, string>()   // tool_use id -> agent id, from the async launch result
    for (const e of entries) if (e.launched) for (const b of e.blocks) if (b.type === 'tool_result') launched.set(b.id, e.launched)
    return (
        <div className="space-y-1">
            {entries.map((e) => {
                const onlyResults = e.blocks.every((b) => b.type === 'tool_result')
                if (onlyResults) return null
                if (e.role === 'user') {
                    return (
                        <div key={e.seq} className="flex justify-end py-1.5">
                            <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-sm border border-accent/25 bg-accent/10 px-3 py-2 text-[13px]">
                                {e.blocks.map((b, n) => (b.type === 'text' ? <span key={n}>{b.text}</span> : b.type === 'image' ? <em key={n} className="text-muted"> [image]</em> : null))}
                            </div>
                        </div>
                    )
                }
                return (
                    <div key={e.seq} className="py-1">
                        {e.blocks.map((b, n) => {
                            if (b.type === 'text') return <Markdown key={n}>{b.text}</Markdown>
                            if (b.type === 'thinking') return <Thinking key={n} text={b.text} redacted={b.redacted} />
                            if (b.type === 'tool_use') {
                                const kid = byUse.get(b.id) ?? (launched.get(b.id) ? byAgent.get(launched.get(b.id) as string) : undefined)
                                return <ToolCard key={n} use={b} result={results.get(b.id)} child={depth < 4 ? kid : undefined} />
                            }
                            return null
                        })}
                    </div>
                )
            })}
            {live}
        </div>
    )
}

export { baseName }
