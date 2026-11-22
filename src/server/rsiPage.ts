import { db } from "~/server/db"
import { likeEsc, offsetOf, paged, type PageQuery, type PageSpec, type Paged } from "~/lib/paging"
import { RSI_DOMAINS, TIERS } from "~/lib/rsiDomains"

export type RsiRow = { id: number; domain: string; subject: string; assetId: number | null; code: string; tier: string; severity: string; status: string; state: string; verdict: string; before: number | null; after: number | null; trend: number | null; nextAction: string }
export type RsiDomainCount = { domain: string; open: number; resolved: number }
export type RsiPageData = { tier: string; domains: RsiDomainCount[]; findings: Paged<RsiRow> }

export const RSI_SPEC: PageSpec = { sorts: ["subject", "domain", "code", "severity", "status", "trend"], sort: "severity", filters: ["domain", "status", "verdict"] }
const SORT_SQL: Record<string, string> = {
    subject: "subject COLLATE NOCASE", domain: "domain", code: "code", status: "status", trend: "COALESCE(afterScore - beforeScore, 0)",
    severity: "CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 WHEN 'info' THEN 2 ELSE 3 END",
}
const VERDICT_SQL = "CASE WHEN status = 'resolved' THEN 'pass' WHEN state = 'fixed' THEN 'unverified' ELSE 'fail' END"
const nn = (v: unknown) => Number(v ?? 0)

/** The asset findings (models, maps, animations, textures at one tier, sounds), one page at a time; the DB sorts, filters and counts. */
export async function loadRsiPage(tierParam: string | undefined, q: PageQuery): Promise<RsiPageData> {
    const tier = (TIERS as readonly string[]).includes(tierParam ?? "") ? (tierParam as string) : "high"
    const doms = RSI_DOMAINS.map((d) => `'${d}'`).join(",")
    const base = `FROM RsiFinding WHERE domain IN (${doms}) AND (domain != 'textures' OR tier = ?)`
    const w: string[] = [], a: unknown[] = [tier]
    if (q.f.domain && (RSI_DOMAINS as readonly string[]).includes(q.f.domain)) { w.push("domain = ?"); a.push(q.f.domain) }
    if (q.f.status) { w.push("status = ?"); a.push(q.f.status) }
    if (q.f.verdict) { w.push(`${VERDICT_SQL} = ?`); a.push(q.f.verdict) }
    if (q.q) { w.push("(subject LIKE ? ESCAPE '\\' OR code LIKE ? ESCAPE '\\' OR msg LIKE ? ESCAPE '\\')"); a.push(...[0, 1, 2].map(() => `%${likeEsc(q.q)}%`)) }
    const where = w.length ? ` AND ${w.join(" AND ")}` : ""
    const [counts, totalRow] = await Promise.all([
        db.$queryRawUnsafe<{ domain: string; open: unknown; resolved: unknown }[]>(`SELECT domain, SUM(status = 'open') open, SUM(status = 'resolved') resolved ${base} GROUP BY domain`, tier),
        db.$queryRawUnsafe<{ c: unknown }[]>(`SELECT COUNT(*) c ${base}${where}`, ...a),
    ])
    const total = nn(totalRow[0].c)
    const rows = await db.$queryRawUnsafe<{ id: unknown; domain: string; subject: string; assetId: number | null; code: string; tier: string; severity: string; status: string; state: string; verdict: string; before: number | null; after: number | null; nextAction: string }[]>(
        `SELECT id, domain, subject, assetId, code, tier, severity, status, state, ${VERDICT_SQL} verdict, beforeScore before, afterScore after, nextAction ${base}${where}
         ORDER BY ${SORT_SQL[q.sort] ?? SORT_SQL.severity} ${q.dir === "desc" ? "DESC" : "ASC"}, id LIMIT ? OFFSET ?`, ...a, q.size, offsetOf(total, q))
    const by = new Map(counts.map((c) => [c.domain, c]))
    return {
        tier,
        domains: RSI_DOMAINS.map((d) => ({ domain: d, open: nn(by.get(d)?.open), resolved: nn(by.get(d)?.resolved) })),
        findings: paged(rows.map((r) => ({ ...r, id: Number(r.id), trend: r.before != null && r.after != null ? r.after - r.before : null })), total, q),
    }
}
