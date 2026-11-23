import { NextResponse, type NextRequest } from 'next/server'
import { ingestOpen, sameOrigin, viewerFromRequest } from '~/server/auth'
import { ensureBootstrap } from '~/server/bootstrap'

// Every page and API needs a signed-in user, except the login itself and the ingest routes.
// Ingest routes (scripts and runners post here) also pass while the ingestOpen setting is on, and
// those that verify a token themselves also pass with a Bearer header (the route then checks it).
// Permissions beyond "signed in" are checked where the data is: tRPC requirePerm and page guards.
const PUBLIC = new Set(['/login', '/api/login', '/api/logout'])
/** Routes that check a Bearer token themselves (perf tokens, feed/heartbeat tokens, NIGHTLY_USAGE_TOKEN). */
const TOKEN_ROUTES = ['/api/perf/ingest', '/api/assets/ingest', '/api/perf/gate', '/api/perf/shot', '/api/agents/heartbeat', '/api/ingest/', '/api/usage/ingest']
/** Routes scripts post to without a token: open only with ingestOpen (or a session). */
const OPEN_ROUTES = ['/api/qa', '/api/review', '/api/annotations']
const under = (list: string[], p: string) => list.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x || p.startsWith(`${x}/`)))

export async function proxy(req: NextRequest) {
    await ensureBootstrap()
    const { pathname } = req.nextUrl
    if (!sameOrigin(req)) return NextResponse.json({ error: 'cross-site request refused' }, { status: 403 })
    if (PUBLIC.has(pathname)) return NextResponse.next()
    if (await viewerFromRequest(req)) return NextResponse.next()
    const tokenRoute = under(TOKEN_ROUTES, pathname)
    if (tokenRoute && /^Bearer\s+\S+/i.test(req.headers.get('authorization') ?? '')) return NextResponse.next()
    if ((tokenRoute || under(OPEN_ROUTES, pathname)) && (await ingestOpen())) return NextResponse.next()
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.search = pathname === '/' ? '' : `?next=${encodeURIComponent(pathname + req.nextUrl.search)}`
    return NextResponse.redirect(url)
}

export const config = { matcher: ['/((?!_next/|favicon.ico|icon.svg).*)'] }
