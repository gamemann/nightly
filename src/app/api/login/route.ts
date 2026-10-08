import { NextResponse } from 'next/server'
import { COOKIE, checkLogin, readAuth, sessionToken } from '~/server/auth'

export async function POST(req: Request) {
    const form = await req.formData()
    const cfg = await readAuth()
    const next = String(form.get('next') || '/')
    const safeNext = next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/'
    // Relative Location: behind a proxy or on 0.0.0.0, req.url's host is not the one the browser used.
    const go = (path: string) => new NextResponse(null, { status: 303, headers: { Location: path } })
    if (!cfg.enabled) return go(safeNext)
    const ok = checkLogin(cfg, String(form.get('username') ?? ''), String(form.get('password') ?? ''))
    if (!ok) {
        await new Promise((r) => setTimeout(r, 400))   // a little friction against guessing
        return go(`/login?error=1&next=${encodeURIComponent(safeNext)}`)
    }
    const res = go(safeNext)
    // Secure whenever the browser is on https (directly or behind a TLS proxy); plain-http LAN use keeps working.
    const secure = new URL(req.url).protocol === 'https:' || req.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https'
    res.cookies.set(COOKIE, sessionToken(cfg), { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge: 60 * 60 * 24 * 90 })
    return res
}
