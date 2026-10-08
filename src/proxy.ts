import { NextResponse, type NextRequest } from 'next/server'
import { COOKIE, readAuth, safeEqual, sessionToken } from '~/server/auth'

// Open unless the login is switched on in Settings.
export async function proxy(req: NextRequest) {
    const cfg = await readAuth()
    if (!cfg.enabled) return NextResponse.next()
    const { pathname } = req.nextUrl
    if (pathname === '/login' || pathname === '/api/login' || pathname === '/api/logout') return NextResponse.next()
    if (safeEqual(req.cookies.get(COOKIE)?.value ?? '', sessionToken(cfg))) return NextResponse.next()
    if (pathname.startsWith('/api/')) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    url.search = `?next=${encodeURIComponent(pathname)}`
    return NextResponse.redirect(url)
}

export const config = { matcher: ['/((?!_next/|favicon.ico|icon.svg).*)'] }
