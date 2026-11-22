"use client"
import Link from "next/link"
import { useMemo, useState } from "react"
import { api, type RouterOutputs } from "~/trpc/react"
import { unitLabel, unitOf } from "../../lib/perf.mjs"
import { ago } from "./pills"
import { Trends } from "./PerfTrends"

type Game = RouterOutputs["perf"]["games"][number]
type Func = RouterOutputs["perf"]["run"]["funcs"][number]
const f2 = (n: number | undefined | null, d = 2) => (n === undefined || n === null ? "-" : Number.isInteger(n) ? String(n) : n.toFixed(d))
const HEAD = ["fps", "frame_ms_p50", "frame_ms_p95", "frame_ms_p99", "tick_ms", "draw_calls", "memory_mb", "net_in_kbps", "net_out_kbps"]
const VERDICT: Record<string, string> = { better: "text-emerald-300", worse: "text-red-300", same: "text-muted", new: "text-sky-300", gone: "text-amber-300" }
const input = "rounded border border-line bg-panel px-2 py-1 text-[12px] outline-none focus:border-sky-400/60"
const btn = "rounded border border-line px-2 py-1 text-[12px] hover:bg-hover disabled:opacity-40"
const scopeLabel = (r: { platform: string; role: string; map: string; bots: number }) => `${r.platform}/${r.role}${r.map ? " " + r.map : ""}${r.bots ? ` ${r.bots}b` : ""}`

export function Perf({ slug }: { slug: string[] }) {
    if ((slug[0] === "compare" || slug[0] === "diff") && slug[1] && slug[2]) return <Shell crumbs={[["Compare", ""]]}><Compare a={Number(slug[1])} b={Number(slug[2])} /></Shell>
    if (slug[0] && slug[1] === "run" && slug[2]) return <Shell crumbs={[[slug[0], `/perf/${slug[0]}`], [`run #${slug[2]}`, ""]]}><RunView id={Number(slug[2])} /></Shell>
    if (slug[0]) return <Shell crumbs={[[slug[0], ""]]}><GameView slug={slug[0]} /></Shell>
    return <Shell crumbs={[]}><Overview /></Shell>
}

function Shell({ crumbs, children }: { crumbs: [string, string][]; children: React.ReactNode }) {
    return (
        <div className="mx-auto max-w-6xl px-6 py-5 max-md:px-3">
            <h1 className="text-[15px] font-semibold tracking-tight">
                <Link href="/perf" className="hover:text-sky-300">Performance</Link>
                {crumbs.map(([t, h]) => <span key={t}> <span className="text-muted">/</span> {h ? <Link href={h} className="hover:text-sky-300">{t}</Link> : t}</span>)}
            </h1>
            {children}
        </div>
    )
}

// ---------- overview ----------

function Overview() {
    const games = api.perf.games.useQuery(undefined, { refetchInterval: 30_000 })
    const [adding, setAdding] = useState(false)
    return (
        <>
            <p className="mt-0.5 mb-4 text-[12px] text-muted">Benchmarks, profiler stacks, budgets and regressions per game. Runs arrive from <code>nightly perf ingest</code>, the HTTP endpoint or the nightly <code>perf run</code>.</p>
            {games.isLoading && <div className="p-6 text-center text-muted">Loading…</div>}
            {games.error && <div className="rounded border border-red-400/40 p-3 text-red-300">{games.error.message} (run <code>nightly perf migrate</code> if the perf tables are missing)</div>}
            <div className="grid gap-3 md:grid-cols-2">
                {games.data?.map((g) => (
                    <Link key={g.slug} href={`/perf/${g.slug}`} className="rounded-lg border border-line bg-panel/40 p-4 hover:bg-hover">
                        <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium">{g.name}</span>
                            <span className="font-mono text-[11px] text-muted">{g.slug}</span>
                            {!g.enabled && <span className="rounded bg-hover px-1 text-[10px] text-muted">disabled</span>}
                            {g.open > 0 && <span className="ml-auto rounded bg-red-400/15 px-1.5 text-[11px] text-red-300">{g.open} over budget</span>}
                        </div>
                        <div className="mt-1 text-[12px] text-muted">{g.runs} run{g.runs === 1 ? "" : "s"}{g.last && <> · last {ago(g.last.ranAt)}{g.last.commit && <> · <span className="font-mono">{g.last.commit.slice(0, 9)}</span></>}</>} · {g.budgets.length} budgets · {g.engine} · {g.platforms.join(", ")}</div>
                    </Link>
                ))}
            </div>
            {games.data?.length === 0 && <div className="rounded-lg border border-line px-3 py-6 text-center text-muted">No games registered yet.</div>}
            <div className="mt-4">
                <button className={btn} onClick={() => setAdding(!adding)}>{adding ? "Cancel" : "Register a game"}</button>
                {adding && <AddGame done={() => { setAdding(false); void games.refetch() }} />}
            </div>
            <h2 className="mt-6 mb-2 text-[13px] font-medium">Findings and fixes</h2>
            <Rsi />
            <h2 className="mt-6 mb-2 text-[13px] font-medium">Ingest tokens</h2>
            <Tokens games={games.data?.map((g) => g.slug) ?? []} />
        </>
    )
}

function AddGame({ done }: { done: () => void }) {
    const add = api.perf.addGame.useMutation({ onSuccess: done })
    const [f, setF] = useState({ id: "", name: "", repo: "", repoPath: "", engine: "godot", platforms: "native,web", owner: "", budgets: "", routing: "{}" })
    const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value })
    return (
        <div className="mt-2 grid max-w-2xl gap-2 rounded-lg border border-line p-3 text-[12px]">
            <div className="grid grid-cols-2 gap-2">
                <input className={input} placeholder="id (fc)" value={f.id} onChange={set("id")} />
                <input className={input} placeholder="name" value={f.name} onChange={set("name")} />
                <input className={input} placeholder="repo (fc-game)" value={f.repo} onChange={set("repo")} />
                <input className={input} placeholder="repo path on the run box" value={f.repoPath} onChange={set("repoPath")} />
                <input className={input} placeholder="engine" value={f.engine} onChange={set("engine")} />
                <input className={input} placeholder="platforms" value={f.platforms} onChange={set("platforms")} />
                <input className={input} placeholder="owner" value={f.owner} onChange={set("owner")} />
            </div>
            <textarea className={`${input} font-mono`} rows={3} placeholder={"budgets, one per line:\nfps>=60@platform=native,role=client\nframe_ms_p95<=33@platform=web"} value={f.budgets} onChange={set("budgets")} />
            <textarea className={`${input} font-mono`} rows={2} placeholder='routing JSON: {"native/client":{"host":"gpu-box","map":"arena","bots":4}}' value={f.routing} onChange={set("routing")} />
            <div className="flex items-center gap-2">
                <button className={btn} disabled={!f.id || !f.name || add.isPending} onClick={() => add.mutate({ ...f, budgets: f.budgets.split("\n").map((s) => s.trim()).filter(Boolean) })}>Add game</button>
                {add.error && <span className="text-red-300">{add.error.message}</span>}
            </div>
        </div>
    )
}

function Findings({ game }: { game?: string }) {
    const q = api.perf.findings.useQuery({ game }, { refetchInterval: 30_000 })
    const rows = q.data ?? []
    if (!rows.length) return <div className="rounded-lg border border-line px-3 py-4 text-center text-[12px] text-muted">No findings. A breached budget files one (and a queue item) automatically.</div>
    return (
        <table className="w-full text-[12px]">
            <thead className="text-left text-muted"><tr><th className="py-1">Game</th><th>Metric</th><th>State</th><th>Value / limit</th><th>Queue item</th><th>Updated</th></tr></thead>
            <tbody>
                {rows.map((f) => (
                    <tr key={f.id} className="border-t border-line">
                        <td className="py-1"><Link className="hover:text-sky-300" href={`/perf/${f.game}`}>{f.game}</Link></td>
                        <td className="font-mono">{f.metric}</td>
                        <td><span className={`rounded px-1.5 ${f.status === "open" ? "bg-red-400/15 text-red-300" : "bg-emerald-400/15 text-emerald-300"}`}>{f.status}</span></td>
                        <td className="tabular-nums">{f2(f.value)}{unitLabel(f.metric)} / {f2(f.limit)} {f.runId ? <Link className="text-muted hover:text-sky-300" href={`/perf/${f.game}/run/${f.runId}`}>#{f.runId}</Link> : null}</td>
                        <td>{f.item ? <><Link className="font-mono hover:text-sky-300" href={`/item/${f.item.key}`}>{f.item.key}</Link><span className="ml-1 text-muted">({f.item.status})</span></> : "-"}</td>
                        <td className="text-muted">{ago(f.updatedAt)}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    )
}

const STATE: Record<string, string> = { found: "bg-red-400/15 text-red-300", fixed: "bg-amber-400/15 text-amber-300", remeasured: "bg-emerald-400/15 text-emerald-300", dismissed: "bg-hover text-muted" }
const what = (f: { kind: string; metric: string; fn: string }) => (f.kind === "offender" ? `fn ${f.fn}` : f.metric)

/** The RSI loop: found -> fixed (its queue item closed) -> remeasured (a later run in the same scope), with the before/after delta. */
function Rsi({ game }: { game?: string }) {
    const q = api.perf.rsi.useQuery({ game }, { refetchInterval: 30_000 })
    const rows = q.data ?? []
    if (!rows.length) return <div className="rounded-lg border border-line px-3 py-4 text-center text-[12px] text-muted">Nothing found yet. A breached budget, a regression against the previous runs or a top offender files a finding and a queue item; closing the item and running again remeasures it here.</div>
    return (
        <table className="w-full text-[12px]">
            <thead className="text-left text-muted"><tr>{!game && <th className="py-1">Game</th>}<th className="py-1">Finding</th><th>Kind</th><th>State</th><th>Queue item</th><th className="text-right">Before</th><th className="text-right">After</th><th className="text-right">Delta</th></tr></thead>
            <tbody>
                {rows.map((f) => {
                    const m = f.kind === "offender" ? "ms" : unitLabel(f.metric.replace(/^regress:/, "").replace(/@.*$/, ""))
                    return (
                        <tr key={f.id} className="border-t border-line">
                            {!game && <td className="py-1"><Link className="hover:text-sky-300" href={`/perf/${f.game}`}>{f.game}</Link></td>}
                            <td className="max-w-[18rem] truncate py-1 font-mono" title={f.note}>{what(f)}</td>
                            <td className="text-muted">{f.kind}{f.cycles > 0 && <span title="completed fix cycles before this one"> x{f.cycles + 1}</span>}</td>
                            <td><span className={`rounded px-1.5 ${STATE[f.state] ?? ""}`}>{f.state}</span></td>
                            <td>{f.itemKey ? <><Link className="font-mono hover:text-sky-300" href={`/item/${f.itemKey}`}>{f.itemKey}</Link><span className="ml-1 text-muted">({f.itemStatus || "-"})</span></> : "-"}</td>
                            <td className="text-right tabular-nums">{f.before != null ? `${f2(f.before, 3)}${m}` : f.state === "found" ? `${f2(f.value, 3)}${m}` : "-"}</td>
                            <td className="text-right tabular-nums">{f.after != null ? <>{f2(f.after, 3)}{m} {f.remeasuredRunId && <Link className="text-muted hover:text-sky-300" href={`/perf/${f.game}/run/${f.remeasuredRunId}`}>#{f.remeasuredRunId}</Link>}{f.remeasuredRunId && f.runId && <Link className="ml-1 text-sky-300" title="differential flame graph: the run that found it vs the run after the fix" href={`/perf/diff/${f.runId}/${f.remeasuredRunId}`}>diff</Link>}</> : "-"}</td>
                            <td className={`text-right tabular-nums ${f.delta == null ? "text-muted" : f.metric.includes("fps") ? (f.delta >= 0 ? "text-emerald-300" : "text-red-300") : f.delta <= 0 ? "text-emerald-300" : "text-red-300"}`}>{f.delta == null ? "-" : `${f.delta > 0 ? "+" : ""}${f2(f.delta, 3)}${f.pct != null ? ` (${f.pct > 0 ? "+" : ""}${f.pct.toFixed(0)}%)` : ""}`}</td>
                        </tr>
                    )
                })}
            </tbody>
        </table>
    )
}

/** Ingest tokens: per runner and/or per game. The secret is shown once; only its hash is stored. */
function Tokens({ games }: { games: string[] }) {
    const utils = api.useUtils()
    const list = api.perf.tokens.useQuery()
    const [name, setName] = useState("")
    const [game, setGame] = useState("")
    const [fresh, setFresh] = useState<{ name: string; token: string } | null>(null)
    const add = api.perf.tokenAdd.useMutation({ onSuccess: (t) => { setFresh({ name: t.name, token: t.token }); setName(""); void utils.perf.tokens.invalidate() } })
    const revoke = api.perf.tokenRevoke.useMutation({ onSuccess: () => void utils.perf.tokens.invalidate() })
    const rows = list.data ?? []
    return (
        <div className="text-[12px]">
            <p className="mb-2 text-muted">{rows.some((t) => !t.revokedAt) ? "HTTP ingest needs a token: Authorization: Bearer <token>." : "No token yet: HTTP ingest is open. Making the first one closes it to runners without a token."}</p>
            {rows.length > 0 && (
                <table className="mb-2 w-full">
                    <thead className="text-left text-muted"><tr><th className="py-1">Name</th><th>Token</th><th>Game</th><th>Last used</th><th /></tr></thead>
                    <tbody>
                        {rows.map((t) => (
                            <tr key={t.id} className="border-t border-line">
                                <td className="py-1 font-mono">{t.name}</td><td className="font-mono text-muted">{t.prefix}...</td><td>{t.game || "any game"}</td>
                                <td className="text-muted">{t.revokedAt ? "revoked" : t.lastUsedAt ? ago(t.lastUsedAt) : "never"}</td>
                                <td className="text-right">{!t.revokedAt && <button className={btn} disabled={revoke.isPending} onClick={() => revoke.mutate({ name: t.name })}>Revoke</button>}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
            <div className="flex flex-wrap items-center gap-2">
                <input className={input} placeholder="runner or game name" value={name} onChange={(e) => setName(e.target.value)} />
                <select className={input} value={game} onChange={(e) => setGame(e.target.value)}><option value="">any game</option>{games.map((g) => <option key={g} value={g}>{g}</option>)}</select>
                <button className={btn} disabled={!name || add.isPending} onClick={() => add.mutate({ name, game })}>Create token</button>
                {(add.error || revoke.error) && <span className="text-red-300">{(add.error ?? revoke.error)?.message}</span>}
            </div>
            {fresh && <div className="mt-2 rounded border border-amber-400/40 p-2">Token for <b>{fresh.name}</b>, shown once, copy it now: <code className="select-all break-all">{fresh.token}</code> <button className="ml-2 text-muted hover:text-sky-300" onClick={() => setFresh(null)}>dismiss</button></div>}
        </div>
    )
}

// ---------- game view ----------

type Scope = { platform?: string; role?: string; map?: string; bots?: number }
const budgetText = (b: Game["budgets"][number]) => {
    const keys = (["platform", "role", "map", "bots"] as const).filter((k) => b[k] !== undefined)
    return `${b.metric}${b.max !== undefined ? "<=" + b.max : ">=" + b.min}${keys.length ? "@" + keys.map((k) => `${k}=${b[k]}`).join(",") : ""}`
}

function GameView({ slug }: { slug: string }) {
    const games = api.perf.games.useQuery()
    const facets = api.perf.facets.useQuery({ game: slug })
    const [tab, setTab] = useState<"trends" | "runs" | "offenders" | "findings" | "rsi" | "budgets">("trends")
    const [scope, setScope] = useState<Scope>({})
    const game = games.data?.find((g) => g.slug === slug)
    const combos = facets.data?.combos ?? []
    const sel = (k: keyof Scope, label: string) => {
        const opts = [...new Set(combos.map((c) => c[k]))].filter((v) => v !== "" && v !== 0 && v !== undefined)
        return (
            <select className={input} value={String(scope[k] ?? "")} onChange={(e) => setScope({ ...scope, [k]: e.target.value === "" ? undefined : k === "bots" ? Number(e.target.value) : e.target.value })}>
                <option value="">{label}: any</option>
                {opts.map((v) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
            </select>
        )
    }
    if (games.data && !game) return <div className="mt-4 text-muted">No game “{slug}”.</div>
    return (
        <>
            <p className="mt-0.5 mb-3 text-[12px] text-muted">{game?.name} · {game?.engine} · {game?.runs ?? 0} runs{game?.owner && <> · owner {game.owner}</>}{game?.repo && <> · {game.repo}</>}</p>
            <div className="mb-3 flex flex-wrap items-center gap-2">
                {(["trends", "runs", "offenders", "findings", "rsi", "budgets"] as const).map((t) => (
                    <button key={t} className={`${btn} ${tab === t ? "bg-hover" : "text-muted"}`} onClick={() => setTab(t)}>{t === "offenders" ? "top offenders" : t}</button>
                ))}
                <span className="ml-auto flex flex-wrap gap-2">{sel("platform", "platform")}{sel("role", "role")}{sel("map", "map")}{sel("bots", "bots")}</span>
            </div>
            {tab === "trends" && <Trends game={slug} scope={scope} onTab={setTab} />}
            {tab === "runs" && <Runs game={slug} scope={scope} />}
            {tab === "offenders" && <Offenders game={slug} scope={scope} />}
            {tab === "findings" && <Findings game={slug} />}
            {tab === "rsi" && <Rsi game={slug} />}
            {tab === "budgets" && game && <Budgets game={game} />}
        </>
    )
}

function Budgets({ game }: { game: Game }) {
    const set = api.perf.setBudgets.useMutation()
    const utils = api.useUtils()
    const [text, setText] = useState(game.budgets.map(budgetText).join("\n"))
    return (
        <div className="max-w-2xl text-[12px]">
            <p className="mb-2 text-muted">One budget per line: <code>metric&lt;=value</code> or <code>metric&gt;=value</code>, optionally <code>@platform=native,role=client,map=arena,bots=4</code>. A run that breaks one files a finding and a queue item.</p>
            <textarea className={`${input} w-full font-mono`} rows={6} value={text} onChange={(e) => setText(e.target.value)} />
            <div className="mt-2 flex items-center gap-2">
                <button className={btn} disabled={set.isPending} onClick={() => set.mutate({ id: game.slug, budgets: text.split("\n").map((s) => s.trim()).filter(Boolean) }, { onSuccess: () => void utils.perf.games.invalidate() })}>Save budgets</button>
                {set.error && <span className="text-red-300">{set.error.message}</span>}{set.isSuccess && <span className="text-emerald-300">saved</span>}
            </div>
            <div className="mt-4 text-muted">Routing: <code>{JSON.stringify(game.routing)}</code> (edit with <code>nightly perf game set --id {game.slug} --routing JSON</code>)</div>
        </div>
    )
}

// ---------- runs list ----------

function Runs({ game, scope }: { game: string; scope: Scope }) {
    const [page, setPage] = useState(0)
    const [q, setQ] = useState("")
    const [pick, setPick] = useState<number[]>([])
    const PAGE = 25
    const runs = api.perf.runs.useQuery({ game, ...scope, page, pageSize: PAGE, q: q || undefined }, { placeholderData: (p) => p })
    const total = runs.data?.total ?? 0
    return (
        <>
            <div className="mb-2 flex items-center gap-2 text-[12px]">
                <input className={input} placeholder="filter: commit, label, map" value={q} onChange={(e) => { setQ(e.target.value); setPage(0) }} />
                {pick.length === 2 ? <Link className={`${btn} text-sky-300`} href={`/perf/compare/${pick[0]}/${pick[1]}`}>Compare #{pick[0]} vs #{pick[1]}</Link> : <span className="text-muted">tick two runs to compare (older = A)</span>}
                <span className="ml-auto text-muted">{total} runs</span>
            </div>
            <table className="w-full text-[12px]">
                <thead className="text-left text-muted"><tr><th /><th className="py-1">Run</th><th>When</th><th>Scope</th><th>Commit</th>{HEAD.map((m) => <th key={m} className="text-right font-mono">{m}</th>)}</tr></thead>
                <tbody>
                    {runs.data?.rows.map((r) => (
                        <tr key={r.id} className="border-t border-line hover:bg-hover/40">
                            <td><input type="checkbox" checked={pick.includes(r.id)} onChange={(e) => setPick(e.target.checked ? [...pick, r.id].slice(-2).sort((a, b) => a - b) : pick.filter((x) => x !== r.id))} /></td>
                            <td className="py-1"><Link className="font-mono hover:text-sky-300" href={`/perf/${game}/run/${r.id}`}>#{r.id}</Link>{r.label && <span className="ml-1 text-muted">{r.label}</span>}</td>
                            <td className="text-muted">{ago(r.ranAt)}</td><td>{scopeLabel(r)}</td><td className="font-mono text-muted">{r.commit.slice(0, 9)}</td>
                            {HEAD.map((m) => <td key={m} className="text-right tabular-nums">{f2(r.metrics[m])}</td>)}
                        </tr>
                    ))}
                </tbody>
            </table>
            <div className="mt-2 flex items-center gap-2 text-[12px] text-muted">
                <button className={btn} disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</button>
                <span>page {page + 1} of {Math.max(1, Math.ceil(total / PAGE))}</span>
                <button className={btn} disabled={(page + 1) * PAGE >= total} onClick={() => setPage(page + 1)}>Older</button>
            </div>
        </>
    )
}

// ---------- top offenders ----------

function Offenders({ game, scope }: { game: string; scope: Scope }) {
    const q = api.perf.offenders.useQuery({ game, ...scope, runs: 5 })
    const rows = q.data?.rows ?? []
    const max = rows[0]?.selfMs || 1
    return (
        <>
            <p className="mb-2 text-[12px] text-muted">Self time, averaged over the newest {q.data?.runs ?? 0} runs in this scope.</p>
            <table className="w-full text-[12px]">
                <thead className="text-left text-muted"><tr><th className="py-1">#</th><th>Function</th><th>Group</th><th>Addon</th><th className="text-right">self ms</th><th className="w-40">share</th><th>history</th><th>Queue item</th></tr></thead>
                <tbody>
                    {rows.map((r, i) => (
                        <tr key={r.name} className="border-t border-line">
                            <td className="py-1 text-muted">{i + 1}</td><td className="font-mono">{r.name}</td><td>{r.grp}</td><td className="text-muted">{r.addon || "-"}</td>
                            <td className="text-right tabular-nums">{f2(r.selfMs, 3)}</td>
                            <td><div className="h-2 rounded bg-sky-400/60" style={{ width: `${(r.selfMs / max) * 100}%` }} title={`${(r.share * 100).toFixed(1)}% of listed time`} /></td>
                            <td><FuncSpark game={game} scope={scope} name={r.name} /></td>
                            <td>{r.itemKey ? <><Link className="font-mono hover:text-sky-300" href={`/item/${r.itemKey}`}>{r.itemKey}</Link>{r.rsi && <span className="ml-1 text-muted">({r.rsi})</span>}</> : <span className="text-muted">-</span>}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
            {q.data && rows.length === 0 && <div className="rounded-lg border border-line px-3 py-6 text-center text-muted">No profiler rows for {game} yet.</div>}
        </>
    )
}

// ---------- one run ----------

function RunView({ id }: { id: number }) {
    const q = api.perf.run.useQuery({ id })
    const d = q.data
    if (q.error) return <div className="mt-4 text-red-300">{q.error.message}</div>
    if (!d) return <div className="p-6 text-center text-muted">Loading…</div>
    const r = d.run
    const keys = Object.keys(d.metrics).sort((a, b) => (HEAD.indexOf(a) < 0 ? 99 : HEAD.indexOf(a)) - (HEAD.indexOf(b) < 0 ? 99 : HEAD.indexOf(b)) || a.localeCompare(b))
    return (
        <>
            <p className="mt-0.5 mb-4 text-[12px] text-muted">{scopeLabel(r)} · {ago(r.ranAt)} · {r.commit ? <span className="font-mono">{r.commit.slice(0, 9)}</span> : "no commit"}{r.gpu && <> · {r.gpu}</>}{r.resolution && <> · {r.resolution}</>}{d.reportJson && <> · <a className="text-sky-300" href={`/api/perf/artefact/${r.id}/report.json`}>raw report</a></>}</p>
            <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-4">
                {keys.map((k) => {
                    const b = d.budgets.find((x) => x.metric === k)
                    return (
                        <div key={k} className={`rounded border p-2 ${b?.breached ? "border-red-400/50 bg-red-400/5" : "border-line"}`}>
                            <div className="font-mono text-[11px] text-muted">{k}</div>
                            <div className="text-[15px] tabular-nums">{f2(d.metrics[k])} <span className="text-[11px] text-muted">{unitOf(k)}</span></div>
                            {b && <div className={`text-[11px] ${b.breached ? "text-red-300" : "text-emerald-300"}`}>{b.breached ? "over" : "within"} {b.max !== undefined ? `max ${b.max}` : `min ${b.min}`}</div>}
                        </div>
                    )
                })}
            </div>
            <Visuals id={id} />
            <Profiler funcs={d.funcs} folded={d.folded} />
        </>
    )
}

/** SVG strings come from lib/perf-viz, which escapes every label. */
function Svg({ svg, label }: { svg: string; label: string }) {
    return <div role="img" aria-label={label} className="overflow-x-auto rounded border border-line bg-panel p-1" dangerouslySetInnerHTML={{ __html: svg }} />
}

function FuncSpark({ game, scope, name }: { game: string; scope: Scope; name: string }) {
    const q = api.perf.funcHistory.useQuery({ game, ...scope, name, limit: 40 }, { staleTime: 60_000 })
    return q.data && q.data.points.length > 1 ? <span title={`${name}: self ms per frame over the last ${q.data.points.length} runs`} dangerouslySetInnerHTML={{ __html: q.data.svg }} /> : <span className="text-muted">-</span>
}

function Visuals({ id }: { id: number }) {
    const q = api.perf.viz.useQuery({ id })
    const d = q.data
    if (!d) return null
    return (
        <section className="mb-5">
            <h2 className="mb-1 text-[13px] font-medium">Call trace and hitches</h2>
            <p className="mb-2 text-[12px] text-muted">Report for READMEs and PRs: <a className="text-sky-300" href={`/api/perf/report/${id}?format=md`}>markdown</a> · <a className="text-sky-300" href={`/api/perf/report/${id}?format=svg`}>svg</a> · <a className="text-sky-300" href={`/api/perf/report/${id}?format=png`}>png</a></p>
            {d.flame ? <Svg svg={d.flame} label="flame graph" /> : <div className="rounded border border-line px-3 py-3 text-[12px] text-muted">No call stacks in this run (ingest a dot-profiler v2 report or a .folded file).</div>}
            {d.hitch && <div className="mt-2"><Svg svg={d.hitch} label="hitch timeline" /></div>}
            {d.shots.length > 0 && (
                <div className="mt-3">
                    <h3 className="mb-1 text-[12px] text-muted">Screenshots ({d.shots.length})</h3>
                    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
                        {d.shots.map((s) => (
                            <a key={s.id} href={`/api/perf/shot/${id}/${s.file}`} target="_blank" rel="noreferrer" className="block rounded border border-line p-1 hover:border-sky-400/60">
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                <img src={`/api/perf/shot/${id}/${s.file}`} alt={s.name} loading="lazy" className="w-full rounded" />
                                <div className="truncate text-[11px] text-muted" title={s.note}>{s.name}{s.note ? ` · ${s.note}` : ""}</div>
                            </a>
                        ))}
                    </div>
                </div>
            )}
        </section>
    )
}

function Profiler({ funcs, folded }: { funcs: Func[]; folded: string | null }) {
    const [view, setView] = useState<"table" | "icicle">("table")
    return (
        <>
            <div className="mb-2 flex gap-2">
                {(["table", "icicle"] as const).map((v) => <button key={v} className={`${btn} ${view === v ? "bg-hover" : "text-muted"}`} onClick={() => setView(v)}>{v === "table" ? "profiler table" : "stacks (icicle)"}</button>)}
            </div>
            {view === "table" ? <FuncTable funcs={funcs} /> : <Icicle stacks={stacksOf(funcs, folded)} />}
        </>
    )
}

type SortKey = "name" | "grp" | "addon" | "selfMs" | "totalMs" | "calls"
function FuncTable({ funcs }: { funcs: Func[] }) {
    const [sort, setSort] = useState<[SortKey, number]>(["selfMs", -1])
    const [grp, setGrp] = useState("")
    const [addon, setAddon] = useState("")
    const [text, setText] = useState("")
    const groups = [...new Set(funcs.map((f) => f.grp))].sort()
    const addons = [...new Set(funcs.map((f) => f.addon || "(game)"))].sort()
    const rows = useMemo(() => funcs.filter((f) => (!grp || f.grp === grp) && (!addon || (f.addon || "(game)") === addon) && (!text || f.name.toLowerCase().includes(text.toLowerCase())))
        .sort((a, b) => (a[sort[0]] > b[sort[0]] ? 1 : a[sort[0]] < b[sort[0]] ? -1 : 0) * sort[1]), [funcs, grp, addon, text, sort])
    const sum = (k: "grp" | "addon") => { const m = new Map<string, number>(); for (const f of funcs) { const key = k === "addon" ? f.addon || "(game)" : f.grp; m.set(key, (m.get(key) ?? 0) + f.selfMs) } return [...m].sort((a, b) => b[1] - a[1]) }
    const th = (k: SortKey, label: string, right = false) => <th className={`cursor-pointer select-none py-1 ${right ? "text-right" : ""}`} onClick={() => setSort([k, sort[0] === k ? -sort[1] : k === "name" || k === "grp" || k === "addon" ? 1 : -1])}>{label}{sort[0] === k ? (sort[1] > 0 ? " ▲" : " ▼") : ""}</th>
    return (
        <>
            <div className="mb-3 grid gap-3 md:grid-cols-2">
                {(["grp", "addon"] as const).map((k) => {
                    const s = sum(k)
                    const tot = s.reduce((a, [, v]) => a + v, 0) || 1
                    return (
                        <div key={k} className="rounded border border-line p-2 text-[12px]">
                            <div className="mb-1 text-muted">self ms per {k === "grp" ? "budget group" : "addon"}</div>
                            {s.slice(0, 8).map(([n, v]) => <div key={n} className="flex items-center gap-2"><span className="w-24 truncate">{n}</span><div className="h-2 rounded bg-sky-400/60" style={{ width: `${(v / tot) * 60}%` }} /><span className="tabular-nums text-muted">{f2(v, 2)}</span></div>)}
                        </div>
                    )
                })}
            </div>
            <div className="mb-2 flex flex-wrap gap-2 text-[12px]">
                <input className={input} placeholder="filter by name" value={text} onChange={(e) => setText(e.target.value)} />
                <select className={input} value={grp} onChange={(e) => setGrp(e.target.value)}><option value="">group: any</option>{groups.map((g) => <option key={g}>{g}</option>)}</select>
                <select className={input} value={addon} onChange={(e) => setAddon(e.target.value)}><option value="">addon: any</option>{addons.map((g) => <option key={g}>{g}</option>)}</select>
                <span className="ml-auto text-muted">{rows.length} of {funcs.length}</span>
            </div>
            <table className="w-full text-[12px]">
                <thead className="text-left text-muted"><tr>{th("name", "Function")}{th("grp", "Group")}{th("addon", "Addon")}{th("selfMs", "self ms", true)}{th("totalMs", "total ms", true)}{th("calls", "calls", true)}</tr></thead>
                <tbody>
                    {rows.slice(0, 500).map((f, i) => (
                        <tr key={`${f.name}${i}`} className="border-t border-line"><td className="py-1 font-mono">{f.name}</td><td>{f.grp}</td><td className="text-muted">{f.addon || "-"}</td>
                            <td className="text-right tabular-nums">{f2(f.selfMs, 3)}</td><td className="text-right tabular-nums">{f2(f.totalMs, 3)}</td><td className="text-right tabular-nums">{f2(f.calls)}</td></tr>
                    ))}
                </tbody>
            </table>
            {rows.length > 500 && <div className="mt-1 text-[11px] text-muted">showing the first 500, filter to narrow</div>}
        </>
    )
}

// ---------- icicle from folded stacks ----------

type Node = { name: string; value: number; kids: Map<string, Node> }
function stacksOf(funcs: Func[], folded: string | null): [string, number][] {
    if (folded) return folded.split("\n").flatMap((l) => { const m = /^(.*\S)\s+(\d+(?:\.\d+)?)$/.exec(l.trim()); return m ? [[m[1], Number(m[2])] as [string, number]] : [] })
    return funcs.filter((f) => f.selfMs > 0).map((f): [string, number] => [`${f.grp};${f.name}`, f.selfMs])
}
function build(stacks: [string, number][]): Node {
    const root: Node = { name: "all", value: 0, kids: new Map() }
    for (const [s, v] of stacks) {
        root.value += v
        let n = root
        for (const part of s.split(";")) {
            let k = n.kids.get(part)
            if (!k) { k = { name: part, value: 0, kids: new Map() }; n.kids.set(part, k) }
            k.value += v
            n = k
        }
    }
    return root
}
function Icicle({ stacks }: { stacks: [string, number][] }) {
    const root = useMemo(() => build(stacks), [stacks])
    const [path, setPath] = useState<string[]>([])
    if (!stacks.length) return <div className="rounded-lg border border-line px-3 py-6 text-center text-muted">No stacks stored for this run (ingest the .folded file).</div>
    let focus = root
    for (const p of path) focus = focus.kids.get(p) ?? focus
    const W = 1000, RH = 18
    const rects: { x: number; w: number; d: number; n: Node; trail: string[] }[] = []
    const walk = (n: Node, x: number, w: number, d: number, trail: string[]) => {
        rects.push({ x, w, d, n, trail })
        let cx = x
        for (const k of [...n.kids.values()].sort((a, b) => b.value - a.value)) {
            const kw = (k.value / (focus.value || 1)) * W
            if (kw >= 0.8 && d < 40) walk(k, cx, kw, d + 1, [...trail, k.name])
            cx += kw
        }
    }
    walk(focus, 0, W, 0, path)
    const depth = Math.max(...rects.map((r) => r.d)) + 1
    const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h }
    return (
        <div>
            <div className="mb-1 text-[12px] text-muted">{path.length ? <button className="text-sky-300" onClick={() => setPath(path.slice(0, -1))}>up</button> : "click a box to zoom"} · {f2(focus.value, 2)} in view</div>
            <svg viewBox={`0 0 ${W} ${depth * RH}`} className="w-full rounded border border-line">
                {rects.map((r, i) => (
                    <g key={i} onClick={() => r.n.kids.size > 0 && setPath(r.trail)} className="cursor-pointer">
                        <rect x={r.x} y={r.d * RH} width={Math.max(r.w - 0.5, 0.5)} height={RH - 1} fill={`hsl(${hue(r.n.name)} 55% 42%)`}><title>{r.n.name}: {f2(r.n.value, 3)} ({((r.n.value / (focus.value || 1)) * 100).toFixed(1)}%)</title></rect>
                        {r.w > 40 && <text x={r.x + 3} y={r.d * RH + 12} fontSize={10} fill="#fff" style={{ pointerEvents: "none" }}>{r.n.name.slice(0, Math.floor(r.w / 6))}</text>}
                    </g>
                ))}
            </svg>
        </div>
    )
}

// ---------- compare ----------

function Compare({ a, b }: { a: number; b: number }) {
    const [noise, setNoise] = useState(5)
    const q = api.perf.compare.useQuery({ a, b, noisePct: noise })
    const d = q.data
    if (q.error) return <div className="mt-4 text-red-300">{q.error.message}</div>
    if (!d) return <div className="p-6 text-center text-muted">Loading…</div>
    const pct = (p: number | undefined) => (p === undefined ? "" : !Number.isFinite(p) ? "new" : `${p > 0 ? "+" : ""}${p.toFixed(1)}%`)
    const sg = (n: number | undefined, dg = 2) => (n === undefined ? "" : (n > 0 ? "+" : "") + f2(n, dg))
    return (
        <>
            <p className="mt-0.5 mb-3 text-[12px] text-muted">A <Link className="font-mono hover:text-sky-300" href={`/perf/${d.a.game}/run/${d.a.id}`}>#{d.a.id}</Link> ({scopeLabel(d.a)}, {d.a.commit.slice(0, 9) || "no commit"}) vs B <Link className="font-mono hover:text-sky-300" href={`/perf/${d.b.game}/run/${d.b.id}`}>#{d.b.id}</Link> ({scopeLabel(d.b)}, {d.b.commit.slice(0, 9) || "no commit"}) · noise band <input className={`${input} w-14`} type="number" value={noise} onChange={(e) => setNoise(Number(e.target.value))} />%</p>
            <DiffFlame a={a} b={b} noise={noise} />
            <table className="mb-6 w-full text-[12px]">
                <thead className="text-left text-muted"><tr><th className="py-1">Metric</th><th className="text-right">A</th><th className="text-right">B</th><th className="text-right">Δ</th><th className="text-right">Δ %</th><th /></tr></thead>
                <tbody>{d.metrics.map((m) => (
                    <tr key={m.metric} className="border-t border-line"><td className="py-1 font-mono">{m.metric}</td><td className="text-right tabular-nums">{f2(m.a)}</td><td className="text-right tabular-nums">{f2(m.b)}</td>
                        <td className={`text-right tabular-nums ${VERDICT[m.verdict]}`}>{sg(m.delta)}</td><td className={`text-right tabular-nums ${VERDICT[m.verdict]}`}>{pct(m.pct)}</td><td className={`pl-2 ${VERDICT[m.verdict]}`}>{m.verdict}</td></tr>
                ))}</tbody>
            </table>
            <h2 className="mb-1 text-[13px] font-medium">Functions (self ms)</h2>
            <table className="w-full text-[12px]">
                <thead className="text-left text-muted"><tr><th className="py-1">Function</th><th>Group</th><th>Addon</th><th className="text-right">A</th><th className="text-right">B</th><th className="text-right">Δ ms</th><th className="text-right">Δ %</th></tr></thead>
                <tbody>{d.funcs.map((f) => (
                    <tr key={f.name} className="border-t border-line"><td className="py-1 font-mono">{f.name}</td><td>{f.grp}</td><td className="text-muted">{f.addon || "-"}</td><td className="text-right tabular-nums">{f2(f.a, 3)}</td><td className="text-right tabular-nums">{f2(f.b, 3)}</td>
                        <td className={`text-right tabular-nums ${VERDICT[f.verdict]}`}>{sg(f.delta, 3)}</td><td className={`text-right tabular-nums ${VERDICT[f.verdict]}`}>{pct(f.pct)}</td></tr>
                ))}</tbody>
            </table>
        </>
    )
}

/** Differential flame graph: red = slower in B, green = faster, grey = inside the noise band. */
function DiffFlame({ a, b, noise }: { a: number; b: number; noise: number }) {
    const q = api.perf.diff.useQuery({ a, b, noisePct: noise })
    const d = q.data
    if (!d) return null
    if (!d.hasStacks) return <div className="mb-4 rounded border border-line px-3 py-3 text-[12px] text-muted">No call stacks stored for one of these runs, so no differential flame graph.</div>
    return (
        <section className="mb-5">
            <h2 className="mb-1 text-[13px] font-medium">Differential flame graph</h2>
            <Svg svg={d.svg} label="differential flame graph" />
            <table className="mt-2 w-full text-[12px]">
                <thead className="text-left text-muted"><tr><th className="py-1">Biggest self-time changes</th><th className="text-right">A ms</th><th className="text-right">B ms</th><th className="text-right">Delta ms</th></tr></thead>
                <tbody>{d.rows.map((r) => <tr key={r.path} className="border-t border-line"><td className="max-w-[34rem] truncate py-1 font-mono" title={r.path}>{r.path.split(";").slice(-2).join(" > ")}</td><td className="text-right tabular-nums">{f2(r.a, 3)}</td><td className="text-right tabular-nums">{f2(r.b, 3)}</td><td className={`text-right tabular-nums ${r.delta > 0 ? "text-red-300" : "text-emerald-300"}`}>{r.delta > 0 ? "+" : ""}{f2(r.delta, 3)}</td></tr>)}</tbody>
            </table>
        </section>
    )
}
