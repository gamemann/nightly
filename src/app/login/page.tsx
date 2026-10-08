import { redirect } from 'next/navigation'
import { readAuth } from '~/server/auth'

export const dynamic = 'force-dynamic'

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
    const { error, next } = await searchParams
    const cfg = await readAuth()
    if (!cfg.enabled) redirect('/')
    const askUser = !!cfg.user
    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-bg">
            <form method="post" action="/api/login" className="w-72 space-y-3 rounded-xl border border-line bg-panel p-6 shadow-2xl">
                <div className="flex items-center gap-2 text-sm font-semibold"><span className="text-accent">●</span> nightly</div>
                <input type="hidden" name="next" value={next ?? '/'} />
                {askUser && <input name="username" autoComplete="username" autoFocus placeholder="Username" className="input w-full" />}
                <input name="password" type="password" autoComplete="current-password" autoFocus={!askUser} placeholder="Password" className="input w-full" />
                {error && <p className="text-xs text-red-400">Wrong {askUser ? 'username or password' : 'password'}.</p>}
                <button className="btn-primary w-full">Sign in</button>
            </form>
        </div>
    )
}
