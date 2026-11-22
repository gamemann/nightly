import { db } from "~/server/db"
import { likeEsc, offsetOf, paged, type PageQuery, type PageSpec, type Paged } from "~/lib/paging"

import { DOMAINS, type Domain } from "~/lib/rsiDomains"
export { DOMAINS, TIERS, type Domain } from "~/lib/rsiDomains"
import { TIERS } from "~/lib/rsiDomains"
const SEV = { error: 0, warn: 1, info: 2 } as Record<string, number>

export type Finding = {
    id: number; domain: string; subject: string; assetId: number | null; code: string; tier: string; severity: string; msg: string
    nextAction: string; state: string; status: string; before: number | null; after: number | null; itemKey: string; href: string
}
export type DomainStat = { domain: Domain; open: number; fixed: number; remeasured: number; total: number; delta: number | null; deltaUnit: string; note: string }
export type WorstAsset = { assetId: number | null; subject: string; score: number; before: number | null; codes: { code: string; tier: string; severity: string }[]; nextAction: string; states: string[] }
export type Board = { tier: string; domains: DomainStat[]; worst: Paged<WorstAsset>; blockers: Paged<Finding>; blockerCodes: string[]; findings: Paged<Finding>; lastRefresh: string; toolMissing: boolean }

export const BLOCKER_SPEC: PageSpec = { sorts: ["subject", "code", "severity", "id"], sort: "id", dir: "desc", filters: ["code", "severity"] }
export const WORST_SPEC: PageSpec = { sorts: ["score", "subject"], sort: "score", dir: "asc" }
export const FINDING_SPEC: PageSpec = { sorts: ["subject", "domain", "code", "severity", "state", "after"], sort: "severity", filters: ["domain", "state", "severity", "status"] }
const SORT_SQL: Record<string, string> = { subject: "subject COLLATE NOCASE", domain: "domain", code: "code", severity: "CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 WHEN 'info' THEN 2 ELSE 3 END", state: "state", after: "COALESCE(after, 0)" }

/** Gate and feed domains link to the page that shows the evidence, not the asset browser. */
const DOMAIN_HREF: Record<string, string> = { visual: "/reviews", netchaos: "/reviews", web: "/web", content: "/content" }

const NO_AUDITOR: Record<string, string> = {
    maps: "No map census data yet: run perf_bench --mesh-census on a map (logs in the rsiCensusDir setting) and `nightly rsi refresh`.",
}

/** Asset findings (textures at the chosen tier) and perf findings as one relation; every list and aggregate below reads it, so the DB does the work. */
const UNION = `
  SELECT 'r' || id AS key, id, domain, subject, assetId, code, tier, severity, msg, nextAction, CASE WHEN status = 'resolved' THEN 'remeasured' ELSE state END AS state, status, beforeScore AS before, afterScore AS after, itemKey
    FROM RsiFinding WHERE domain != 'process' AND (domain != 'textures' OR tier = ?)
  UNION ALL
  SELECT 'p' || id, id, 'perf', game, NULL, metric, '', CASE WHEN status = 'open' THEN 'warn' ELSE 'info' END, note,
    CASE WHEN itemKey != '' THEN 'Fix agent works ' || itemKey ELSE 'Queue a fix item from this finding' END, state,
    CASE WHEN status = 'resolved' OR state = 'remeasured' THEN 'resolved' ELSE 'open' END, beforeValue, afterValue, itemKey FROM PerfFinding`
type Raw = { id: unknown; domain: string; subject: string; assetId: number | null; code: string; tier: string; severity: string; msg: string; nextAction: string; state: string; status: string; before: number | null; after: number | null; itemKey: string }
const toFinding = (r: Raw): Finding => ({ ...r, id: Number(r.id), href: r.domain === "perf" ? "/perf" : r.assetId ? `/assets/${r.assetId}` : DOMAIN_HREF[r.domain] ?? "/assets" })
const nn = (v: unknown) => Number(v ?? 0)

/** Everything the home page shows: per-domain RSI state (SQL aggregates), worst-scoring assets, blockers and one page of findings. */
export async function loadBoard(tierParam: string | undefined, q: PageQuery, bq: PageQuery, wq: PageQuery): Promise<Board> {
    const tier = (TIERS as readonly string[]).includes(tierParam ?? "") ? (tierParam as string) : "high"
    const w: string[] = [], a: unknown[] = [tier]
    for (const k of ["domain", "state", "severity", "status"]) if (q.f[k]) { w.push(`${k} = ?`); a.push(q.f[k]) }
    if (q.q) { w.push("(subject LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR msg LIKE ? ESCAPE '\\')"); a.push(...[0, 1, 2].map(() => `%${likeEsc(q.q)}%`)) }
    const where = w.length ? `WHERE ${w.join(" AND ")}` : ""
    const wlike = wq.q ? ` AND subject LIKE ? ESCAPE '\\'` : ""
    const wargs: unknown[] = wq.q ? [tier, `%${likeEsc(wq.q)}%`] : [tier]
    const wbase = `FROM RsiFinding WHERE domain NOT IN ('process') AND status = 'open' AND (domain != 'textures' OR tier = ?)${wlike}`
    const bwhere = {
        domain: "process", status: "open",
        ...(bq.f.code ? { code: bq.f.code } : {}), ...(bq.f.severity ? { severity: bq.f.severity } : {}),
        ...(bq.q ? { OR: [{ subject: { contains: bq.q } }, { code: { contains: bq.q } }, { msg: { contains: bq.q } }] } : {}),
    }
    const [stats, totalRow, worstTotal, blockerCount, blockerCodes, last, noTool] = await Promise.all([
        db.$queryRawUnsafe<{ domain: string; total: unknown; open: unknown; fixed: unknown; remeasured: unknown; delta: number | null }[]>(
            `WITH f AS (${UNION}) SELECT domain, COUNT(*) total, SUM(status = 'open' AND state = 'found') open, SUM(state = 'fixed') fixed, SUM(state = 'remeasured') remeasured,
               AVG(CASE WHEN state = 'remeasured' AND before IS NOT NULL AND after IS NOT NULL THEN after - before END) delta FROM f GROUP BY domain`, tier),
        db.$queryRawUnsafe<{ c: unknown }[]>(`WITH f AS (${UNION}) SELECT COUNT(*) c FROM f ${where}`, ...a),
        db.$queryRawUnsafe<{ c: unknown }[]>(`SELECT COUNT(DISTINCT subject) c ${wbase}`, ...wargs),
        db.rsiFinding.count({ where: bwhere }),
        db.rsiFinding.groupBy({ by: ["code"], where: { domain: "process", status: "open" } }),
        db.setting.findUnique({ where: { key: "rsiLastRefreshAt" } }),
        db.rsiFinding.count({ where: { domain: "process", status: "open", code: "NO_AUDIT_TOOL" } }),
    ])
    const wTotal = nn(worstTotal[0].c)
    const worstSort = wq.sort === "subject" ? "subject COLLATE NOCASE" : "score"
    const worstRows = await db.$queryRawUnsafe<{ subject: string; assetId: number | null; score: number; before: number | null }[]>(
        `SELECT subject, MIN(assetId) assetId, MIN(COALESCE(afterScore, 100)) score, MIN(beforeScore) before ${wbase} GROUP BY subject ORDER BY ${worstSort} ${wq.dir === "desc" ? "DESC" : "ASC"}, subject LIMIT ? OFFSET ?`,
        ...wargs, wq.size, offsetOf(wTotal, wq))
    const bcol = { subject: "subject", code: "code", severity: "severity", id: "id" }[bq.sort] ?? "id"
    const blockerRows = await db.rsiFinding.findMany({ where: bwhere, orderBy: [{ [bcol]: bq.dir }, { id: "desc" }], skip: offsetOf(blockerCount, bq), take: bq.size })
    const total = nn(totalRow[0].c)
    const off = offsetOf(total, q)
    const rows = await db.$queryRawUnsafe<Raw[]>(
        `WITH f AS (${UNION}) SELECT * FROM f ${where} ORDER BY ${SORT_SQL[q.sort] ?? SORT_SQL.severity} ${q.dir === "desc" ? "DESC" : "ASC"}, key LIMIT ? OFFSET ?`, ...a, q.size, off)
    const by = new Map(stats.map((s) => [s.domain, s]))
    const domains = DOMAINS.map((d): DomainStat => {
        const s = by.get(d)
        return { domain: d, open: nn(s?.open), fixed: nn(s?.fixed), remeasured: nn(s?.remeasured), total: nn(s?.total), delta: s?.delta ?? null, deltaUnit: d === "perf" ? "" : " pts", note: s ? "" : NO_AUDITOR[d] ?? "Nothing found: the audit raises no findings here." }
    })
    const subjects = worstRows.map((r) => r.subject)
    const flags = subjects.length ? await db.rsiFinding.findMany({ where: { subject: { in: subjects }, status: "open", domain: { not: "process" } }, select: { domain: true, subject: true, code: true, tier: true, severity: true, state: true, nextAction: true } }) : []
    const worst = worstRows.map((r): WorstAsset => {
        const fl = flags.filter((x) => x.subject === r.subject && (x.domain !== "textures" || x.tier === tier))
        const top = [...fl].sort((x, y) => (SEV[x.severity] ?? 3) - (SEV[y.severity] ?? 3))[0]
        return { assetId: r.assetId, subject: r.subject, score: r.score, before: r.before, codes: fl.map((x) => ({ code: x.code, tier: x.tier, severity: x.severity })), nextAction: top?.nextAction ?? "", states: [...new Set(fl.map((x) => x.state))] }
    })
    const blockers = blockerRows.map((r): Finding => ({
        id: r.id, domain: "process", subject: r.subject, assetId: null, code: r.code, tier: "", severity: r.severity, msg: r.msg, nextAction: r.nextAction, state: r.state, status: r.status, before: null, after: null, itemKey: r.subject,
        href: r.code === "NO_AUDIT_TOOL" ? "/assets" : `/item/${r.subject}`,
    }))
    return { tier, domains, worst: paged(worst, wTotal, wq), blockers: paged(blockers, blockerCount, bq), blockerCodes: blockerCodes.map((c) => c.code).sort(), findings: paged(rows.map(toFinding), total, q), lastRefresh: last?.value ?? "", toolMissing: noTool > 0 }
}
