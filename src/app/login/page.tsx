import { redirect } from 'next/navigation'
import { getViewer } from '~/server/auth'
import { Moon } from '~/components/shell/Moon'

export const dynamic = 'force-dynamic'

export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
    const { error, next } = await searchParams
    if (await getViewer()) redirect(next?.startsWith('/') && !next.startsWith('//') ? next : '/')
    return (
        <div className="night-sky fixed inset-0 z-50 grid place-items-center">
            <form method="post" action="/api/login" className="glow-card w-80 space-y-3 p-6">
                <div className="flex items-center gap-2 text-base font-semibold"><Moon className="h-5 w-5" /> Nightly</div>
                <input type="hidden" name="next" value={next ?? '/'} />
                <input name="username" autoComplete="username" autoFocus required placeholder="Username" className="input w-full" />
                <input name="password" type="password" autoComplete="current-password" required placeholder="Password" className="input w-full" />
                {error && <p className="text-xs text-red-400">{error === 'limited' ? 'Too many attempts. Try again in 15 minutes.' : 'Wrong username or password.'}</p>}
                <button className="btn-primary w-full">Sign in</button>
            </form>
        </div>
    )
}
