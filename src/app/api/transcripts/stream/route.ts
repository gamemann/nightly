import { closeSync, openSync, readSync, statSync } from 'node:fs'
import path from 'node:path'
import { db } from '~/server/db'
import { getViewer } from '~/server/transcriptsAccess'
import { viewerFromRequest } from '~/server/auth'

// Server-sent events for one conversation. Read-only: it stat-polls the session file (so a VS Code window writing to the same
// session shows up too) and, while a panel run is live, tails that run's out.ndjson for the partial text claude is typing.
//   event: changed   {size}                      the jsonl grew: the client fetches `transcripts.messages({after})`
//   event: delta     {kind:'text'|'thinking', text}   streamed fragment of the entry in progress
//   event: turn      {state:'running'|'idle', costUsd?, isError?}
//   event: run       {id|null, status}           the live run for this conversation came or went
export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

type Row = Record<string, unknown>
const size = (f: string) => { try { return statSync(f).size } catch { return -1 } }

function readFrom(file: string, from: number) {
    const n = size(file)
    if (n <= from) return { text: '', next: n < from ? 0 : from }
    const fd = openSync(file, 'r')
    try {
        const len = Math.min(n - from, 4 << 20), b = Buffer.alloc(len)
        readSync(fd, b, 0, len, from)
        const cut = b.lastIndexOf(10)
        if (cut < 0) return { text: '', next: from }
        return { text: b.subarray(0, cut + 1).toString('utf8'), next: from + cut + 1 }
    } finally { closeSync(fd) }
}

export async function GET(req: Request) {
    const id = Number(new URL(req.url).searchParams.get('id'))
    if (!Number.isInteger(id) || id <= 0) return Response.json({ error: 'bad id' }, { status: 400 })
    const account = await viewerFromRequest(req)
    if (!account) return Response.json({ error: 'sign in first' }, { status: 401 })
    const v = await getViewer({ db, viewer: account })
    const rows = (await db.$queryRawUnsafe('SELECT filePath, sessionId, osUser FROM Transcript WHERE id = ?', id)) as Row[]
    if (!rows[0] || !v.can('transcripts.view') || !v.canSee(String(rows[0].osUser))) return Response.json({ error: 'not found' }, { status: 404 })
    const file = String(rows[0].filePath), session = String(rows[0].sessionId)
    const enc = new TextEncoder()
    let timer: ReturnType<typeof setInterval> | undefined

    const stream = new ReadableStream({
        start(ctl) {
            const send = (event: string, data: unknown) => { try { ctl.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) } catch { /* closed */ } }
            let last = size(file), runId: number | null = null, runDir = '', outOff = 0, tickN = 0, runStatus = '', busy = false
            const close = () => { clearInterval(timer); try { ctl.close() } catch { /* already */ } }
            req.signal.addEventListener('abort', close)
            send('hello', { size: last })

            const tick = async () => {
                if (busy) return
                busy = true
                try {
                    const n = size(file)
                    if (n !== last) { last = n; send('changed', { size: n }) }
                    if (tickN++ % 4 === 0) {   // the run lookup is a query: every 2 s is plenty
                        const r = (await db.$queryRawUnsafe(`SELECT id, dir, status FROM TranscriptRun WHERE status IN ('starting','running','idle') AND (transcriptId = ? OR sessionId = ?) ORDER BY id DESC LIMIT 1`, id, session)) as Row[]
                        const nid = r[0] ? Number(r[0].id) : null
                        if (nid !== runId) {
                            runId = nid; runDir = r[0] ? String(r[0].dir) : ''
                            outOff = runDir ? Math.max(0, size(path.join(runDir, 'out.ndjson'))) : 0   // only what is typed from now on
                            runStatus = r[0] ? String(r[0].status) : ''; send('run', { id: runId, status: runStatus || null })
                        } else if (r[0] && String(r[0].status) !== runStatus) { runStatus = String(r[0].status); send('run', { id: runId, status: runStatus }) }
                    }
                    if (runDir) {
                        const { text, next } = readFrom(path.join(runDir, 'out.ndjson'), outOff)
                        outOff = next
                        for (const line of text.split('\n')) {
                            if (!line) continue
                            let o: Record<string, any>
                            try { o = JSON.parse(line) } catch { continue }
                            if (o.type === 'stream_event' && o.event?.type === 'content_block_delta' && !o.parent_tool_use_id) {
                                const d = o.event.delta
                                if (d?.type === 'text_delta') send('delta', { kind: 'text', text: d.text })
                                else if (d?.type === 'thinking_delta') send('delta', { kind: 'thinking', text: d.thinking })
                            } else if (o.type === 'stream_event' && o.event?.type === 'message_start') send('turn', { state: 'running' })
                            else if (o.type === 'result') send('turn', { state: 'idle', costUsd: o.total_cost_usd ?? null, isError: !!o.is_error })
                        }
                    }
                    if (tickN % 30 === 0) ctl.enqueue(enc.encode(': keepalive\n\n'))
                } catch { /* a bad tick must not end the stream */ } finally { busy = false }
            }
            timer = setInterval(tick, 500)
        },
        cancel() { clearInterval(timer) },
    })
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } })
}
