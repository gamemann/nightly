import { NextResponse } from 'next/server'
import { COOKIE, cookieFrom, endSession } from '~/server/auth'

export async function POST(req: Request) {
    await endSession(cookieFrom(req.headers.get('cookie')))
    const res = new NextResponse(null, { status: 303, headers: { Location: '/login' } })
    res.cookies.delete(COOKIE)
    return res
}
