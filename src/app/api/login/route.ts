import { NextResponse } from 'next/server'
import { COOKIE, clientIp, cookieOptions, login, safeNext } from '~/server/auth'

// Form post from /login. Relative Location: behind a proxy or on 0.0.0.0, req.url's host is not the one the browser used.
export async function POST(req: Request) {
    const form = await req.formData()
    const next = safeNext(String(form.get('next') || '/'))
    const go = (path: string, status = 303) => new NextResponse(null, { status, headers: { Location: path } })
    const r = await login(String(form.get('username') ?? ''), String(form.get('password') ?? ''), { ip: clientIp(req), userAgent: req.headers.get('user-agent') ?? '' })
    if (!r.ok) {
        await new Promise((res) => setTimeout(res, 400)) // a little friction against guessing
        if (r.reason === 'limited') return new NextResponse(null, { status: 429, headers: { Location: `/login?error=limited&next=${encodeURIComponent(next)}`, 'Retry-After': '900', Refresh: `0; url=/login?error=limited&next=${encodeURIComponent(next)}` } })
        return go(`/login?error=1&next=${encodeURIComponent(next)}`)
    }
    const res = go(next)
    res.cookies.set(COOKIE, r.token, cookieOptions(req))
    return res
}
