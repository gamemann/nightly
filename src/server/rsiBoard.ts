import { db } from "~/server/db"

export const DOMAINS = ["perf", "weapons", "textures", "animations", "sounds", "maps"] as const
export type Domain = (typeof DOMAINS)[number]
export const TIERS = ["low", "medium", "high"] as const
const SEV = { error: 0, warn: 1, info: 2 } as Record<string, number>

export type Finding = {
    id: number; domain: string; subject: string; assetId: number | null; code: string; tier: string; severity: string; msg: string
    nextAction: string; state: string; status: string; before: number | null; after: number | null; itemKey: string; href: string
}
export type DomainStat = { domain: Domain; open: number; fixed: number; remeasured: number; delta: number | null; deltaUnit: string; note: string; findings: Finding[] }
export type WorstAsset = { assetId: number | null; subject: string; score: number; before: number | null; codes: { code: string; tier: string; severity: string }[]; nextAction: string; states: string[] }
export type Board = { tier: string; domains: DomainStat[]; worst: WorstAsset[]; blockers: Finding[]; lastRefresh: string; toolMissing: boolean }

const NO_AUDITOR: Record<string, string> = {
    maps: "No map census data yet: run perf_bench --mesh-census on a map (logs in the rsiCensusDir setting) and `nightly rsi refresh`.",
}

/** Everything the home page shows: per-domain RSI state, worst-scoring assets, blockers. */
export async function loadBoard(tierParam?: string): Promise<Board> {
    const tier = (TIERS as readonly string[]).includes(tierParam ?? "") ? (tierParam as string) : "high"
    const [rows, perf, last] = await Promise.all([db.rsiFinding.findMany(), db.perfFinding.findMany({ orderBy: { updatedAt: "desc" } }), db.setting.findUnique({ where: { key: "rsiLastRefreshAt" } })])
    const asset: Finding[] = rows.filter((r) => r.domain !== "process" && (r.domain !== "textures" || r.tier === tier)).map((r) => ({
        id: r.id, domain: r.domain, subject: r.subject, assetId: r.assetId, code: r.code, tier: r.tier, severity: r.severity, msg: r.msg, nextAction: r.nextAction,
        state: r.status === "resolved" ? "remeasured" : r.state, status: r.status, before: r.beforeScore, after: r.afterScore, itemKey: r.itemKey,
        href: r.assetId ? `/assets/${r.assetId}` : "/assets",
    }))
    const perfF: Finding[] = perf.map((p) => ({
        id: p.id, domain: "perf", subject: `${p.game}`, assetId: null, code: p.metric, tier: "", severity: p.status === "open" ? "warn" : "info", msg: p.note, nextAction: p.itemKey ? `Fix agent works ${p.itemKey}` : "Queue a fix item from this finding",
        state: p.state, status: p.status === "resolved" || p.state === "remeasured" ? "resolved" : "open", before: p.beforeValue, after: p.afterValue, itemKey: p.itemKey, href: "/perf",
    }))
    const all = [...asset, ...perfF]
    const domains = DOMAINS.map((d): DomainStat => {
        const f = all.filter((x) => x.domain === d)
        const rem = f.filter((x) => x.state === "remeasured" && x.before != null && x.after != null)
        const delta = rem.length ? rem.reduce((n, x) => n + ((x.after as number) - (x.before as number)), 0) / rem.length : null
        const ord = (x: Finding) => (x.status === "open" ? 0 : 1) * 10 + (SEV[x.severity] ?? 3)
        return { domain: d, open: f.filter((x) => x.status === "open" && x.state === "found").length, fixed: f.filter((x) => x.state === "fixed").length, remeasured: f.filter((x) => x.state === "remeasured").length,
            delta, deltaUnit: d === "perf" ? "" : " pts", note: f.length ? "" : NO_AUDITOR[d] ?? "Nothing found: the audit raises no findings here.", findings: f.sort((a, b) => ord(a) - ord(b) || (a.after ?? 0) - (b.after ?? 0)) }
    })
    const bySubject = new Map<string, Finding[]>()
    for (const f of asset.filter((x) => x.status === "open")) bySubject.set(f.subject, [...(bySubject.get(f.subject) ?? []), f])
    const worst = [...bySubject.entries()].map(([subject, fl]): WorstAsset => {
        const top = [...fl].sort((a, b) => (SEV[a.severity] ?? 3) - (SEV[b.severity] ?? 3))[0]
        return { assetId: fl[0].assetId, subject, score: Math.min(...fl.map((x) => x.after ?? 100)), before: fl[0].before, codes: fl.map((x) => ({ code: x.code, tier: x.tier, severity: x.severity })),
            nextAction: top.nextAction, states: [...new Set(fl.map((x) => x.state))] }
    }).sort((a, b) => a.score - b.score).slice(0, 15)
    const blockers = rows.filter((r) => r.domain === "process" && r.status === "open").map((r): Finding => ({
        id: r.id, domain: "process", subject: r.subject, assetId: null, code: r.code, tier: "", severity: r.severity, msg: r.msg, nextAction: r.nextAction, state: r.state, status: r.status, before: null, after: null, itemKey: r.subject,
        href: r.code === "NO_AUDIT_TOOL" ? "/assets" : `/item/${r.subject}`,
    }))
    return { tier, domains, worst, blockers, lastRefresh: last?.value ?? "", toolMissing: blockers.some((b) => b.code === "NO_AUDIT_TOOL") }
}
