'use client'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { api } from '~/trpc/react'

// The fallbacks are the runner's own defaults (the run.sh prompt), so an unset key shows what it uses.
const USAGE_LIMITS = [
    { key: 'usageMaxFiveHour', label: '5-hour window', fallback: '80' },
    { key: 'usageMaxWeekly', label: 'Weekly window', fallback: '90' },
]
const HIDDEN = new Set(['doRun', 'runner', 'lastTickAt', 'lastTickBy', 'authEnabled', 'authUser', ...USAGE_LIMITS.map((u) => u.key)])

export function Settings() {
    const utils = api.useUtils()
    const s = api.setting.all.useQuery()
    const set = api.setting.set.useMutation({ onSuccess: () => utils.setting.all.invalidate() })
    const on = s.data?.doRun === 'true'
    return (
        <div className="mx-auto max-w-3xl px-6 py-5 max-md:px-3">
            <h1 className="mb-4 text-[15px] font-semibold tracking-tight">Settings</h1>
            <div className="flex items-center justify-between gap-6 rounded-lg border border-line bg-panel/60 p-4">
                <div>
                    <div className="font-medium">Nightly run</div>
                    <p className="mt-0.5 text-[12px] text-muted">
                        When off, no <Link href="/schedules" className="text-dim hover:text-accent">schedule</Link> starts on its own (<code className="font-mono">nightly get doRun</code>); Run now still works. Turn it off when the plan limit is close.
                    </p>
                </div>
                <button role="switch" aria-checked={on} disabled={!s.data || set.isPending}
                    onClick={() => set.mutate({ key: 'doRun', value: on ? 'false' : 'true' })}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                    <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
            </div>
            <div className="mt-4 rounded-lg border border-line bg-panel/60 p-4">
                <div className="font-medium">Usage limits</div>
                <p className="mt-0.5 mb-3 text-[12px] text-muted">
                    Before starting, the runner reads the plan&apos;s usage (<code className="font-mono">~/stack/scripts/claude-usage.sh</code>) and skips the night if either window is at or past its limit. The run re-checks between items and wraps up when it crosses one. If the check itself breaks, the run goes ahead as before and is told to fix it.
                </p>
                {USAGE_LIMITS.map(({ key, label, fallback }) => (
                    <label key={key} className="flex items-center gap-3 py-1 text-[12px]">
                        <span className="w-40 text-dim">{label}</span>
                        <input type="number" min={1} max={100} step={1} disabled={!s.data || set.isPending}
                            key={s.data?.[key] ?? fallback}
                            defaultValue={s.data?.[key] ?? fallback}
                            onBlur={(e) => {
                                const n = Math.round(Number(e.target.value))
                                if (n >= 1 && n <= 100 && String(n) !== (s.data?.[key] ?? fallback)) set.mutate({ key, value: String(n) })
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                            className="w-20 rounded border border-line bg-transparent px-2 py-1 font-mono" />
                        <span className="text-muted">%</span>
                    </label>
                ))}
            </div>
            <LoginSettings />
            <div className="mt-4 rounded-lg border border-line bg-panel/60 p-4">
                <div className="font-medium">Runner</div>
                <p className="mt-0.5 mb-3 text-[12px] text-muted">
                    The script a schedule starts, through <code className="font-mono">nightly exec</code>. Empty = the <Link href="/prompts/run.sh" className="text-dim hover:text-accent">run.sh</Link> script in Prompts; a path here overrides it. It decides which repositories are safe and launches Claude.
                </p>
                <input key={s.data?.runner ?? ''} defaultValue={s.data?.runner ?? ''} placeholder="run.sh from Prompts" disabled={!s.data || set.isPending}
                    onBlur={(e) => e.target.value.trim() !== (s.data?.runner ?? '') && set.mutate({ key: 'runner', value: e.target.value.trim() })}
                    onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }}
                    className="input w-full font-mono" spellCheck={false} />
            </div>
            {s.data && Object.keys(s.data).filter((k) => !HIDDEN.has(k)).length > 0 && (
                <div className="mt-4 rounded-lg border border-line bg-panel/60 p-4">
                    <div className="label mb-2">Other settings</div>
                    {Object.entries(s.data).filter(([k]) => !HIDDEN.has(k)).map(([k, v]) => (
                        <div key={k} className="flex gap-3 py-0.5 text-[12px]"><span className="w-40 font-mono text-muted">{k}</span><span className="truncate text-dim">{v}</span></div>
                    ))}
                </div>
            )}
        </div>
    )
}

function LoginSettings() {
    const utils = api.useUtils()
    const status = api.auth.status.useQuery()
    const [on, setOn] = useState(false)
    const [user, setUser] = useState('')
    const [password, setPassword] = useState('')
    const [done, setDone] = useState('')
    useEffect(() => {
        if (status.data) { setOn(status.data.enabled); setUser(status.data.user) }
    }, [status.data])
    const configure = api.auth.configure.useMutation({
        onSuccess: async (r) => {
            // Changing the login invalidates this browser's cookie too: sign straight back in with what was typed.
            if (r.enabled && password) {
                const f = new FormData()
                f.set('username', user)
                f.set('password', password)
                await fetch('/api/login', { method: 'POST', body: f, redirect: 'manual' })
            }
            setPassword('')
            setDone(r.enabled ? 'Saved. The panel now asks for a login.' : 'Saved. The panel is open to anyone who can reach it.')
            if (r.enabled && !password) window.location.href = '/login'
            await utils.auth.status.invalidate()
        },
    })
    const s = status.data
    const changed = !!s && (on !== s.enabled || user !== s.user || !!password)
    const err = configure.error?.data?.zodError?.fieldErrors
    return (
        <div className="mt-4 rounded-lg border border-line bg-panel/60 p-4">
            <div className="flex items-center justify-between gap-6">
                <div>
                    <div className="font-medium">Login</div>
                    <p className="mt-0.5 text-[12px] text-muted">
                        Off: anyone who can reach the panel can use it. On: a password (and a username, if you set one) is asked for first; a sign-in lasts 90 days.
                        Locked out? On this machine: <code className="font-mono">bin/nightly set-setting authEnabled false</code>.
                    </p>
                </div>
                <button role="switch" aria-checked={on} disabled={!s} onClick={() => { setOn(!on); setDone('') }}
                    className={`relative h-6 w-11 shrink-0 rounded-full transition ${on ? 'bg-emerald-500' : 'bg-zinc-700'}`}>
                    <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${on ? 'left-[22px]' : 'left-0.5'}`} />
                </button>
            </div>
            {on && (
                <div className="mt-3 grid gap-2 text-[12px]">
                    <label className="flex items-center gap-3">
                        <span className="w-40 text-dim">Username <span className="text-muted">(optional)</span></span>
                        <input value={user} onChange={(e) => setUser(e.target.value)} autoComplete="off" placeholder="none: password only" className="input w-56" />
                    </label>
                    <label className="flex items-center gap-3">
                        <span className="w-40 text-dim">{s?.hasPassword ? 'New password' : 'Password'}</span>
                        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password"
                            placeholder={s?.hasPassword ? 'leave empty to keep it' : 'at least 8 characters'} className="input w-56" />
                    </label>
                    {(err?.user || err?.password) && <p className="text-red-300">{[...(err.user ?? []), ...(err.password ?? [])].join(' ')}</p>}
                </div>
            )}
            <div className="mt-3 flex items-center gap-3">
                <button className="btn-primary" disabled={!changed || configure.isPending}
                    onClick={() => configure.mutate({ enabled: on, user: on ? user : s?.user ?? '', password: on && password ? password : undefined })}>Save</button>
                {s?.enabled && (
                    <form method="post" action="/api/logout"><button className="btn">Sign out</button></form>
                )}
                {configure.error && !err && <span className="text-[12px] text-red-300">{configure.error.message}</span>}
                {done && <span className="text-[12px] text-emerald-300">{done}</span>}
            </div>
        </div>
    )
}
