// ClickHouse over its HTTP interface (plain fetch, no driver). The Usage tab works without it; this only adds long-range history.
// Config: settings usageChEnabled/usageChUrl/usageChDb/usageChUser/usageChPasswordEnv, each with an env fallback
// (NIGHTLY_CLICKHOUSE_URL/DB/USER, and the password from the env var NAMED by usageChPasswordEnv, default NIGHTLY_CLICKHOUSE_PASSWORD).
// Pure (no SQLite): the panel imports it too. The password is never stored in the database, never put in a URL and never printed.

export const CH_TABLES = ['usage_message', 'usage_tool', 'usage_event']
/** Tables chInsert may write: the usage tables plus the lines-of-code history (loc.mjs). */
export const CH_WRITABLE = [...CH_TABLES, 'loc_history']
const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/

/** `get(key)` reads a setting (null if unset). Returns the config; `enabled` is true only when switched on AND a URL is known. */
export function chConfig(get, env = process.env) {
    const pwEnv = get('usageChPasswordEnv') || 'NIGHTLY_CLICKHOUSE_PASSWORD'
    const cfg = {
        enabled: (get('usageChEnabled') ?? (env.NIGHTLY_CLICKHOUSE_URL ? 'true' : 'false')) === 'true',
        url: (get('usageChUrl') || env.NIGHTLY_CLICKHOUSE_URL || 'http://127.0.0.1:8123').replace(/\/+$/, ''),
        db: get('usageChDb') || env.NIGHTLY_CLICKHOUSE_DB || 'nightly_usage',
        user: get('usageChUser') || env.NIGHTLY_CLICKHOUSE_USER || 'default',
        passwordEnv: pwEnv,
        password: env[pwEnv] ?? '',
        batch: Math.max(1, Number(get('usageChBatch')) || 5000),
    }
    if (!IDENT.test(cfg.db)) throw new Error(`usageChDb "${cfg.db}" is not a valid database name`)
    return cfg
}
/** What is safe to show: everything but the password. */
export const publicConfig = (c) => ({ enabled: c.enabled, url: c.url, db: c.db, user: c.user, passwordEnv: c.passwordEnv, passwordSet: !!c.password })

const headers = (c) => ({ 'X-ClickHouse-User': c.user, ...(c.password ? { 'X-ClickHouse-Key': c.password } : {}), 'X-ClickHouse-Database': c.db })

export async function chCall(c, params, body, { fetchImpl = fetch, timeoutMs = 30_000 } = {}) {
    const url = `${c.url}/?${new URLSearchParams(params)}`
    let res
    try { res = await fetchImpl(url, { method: 'POST', headers: headers(c), body, signal: AbortSignal.timeout(timeoutMs) }) }
    catch (e) { throw new Error(`ClickHouse unreachable at ${c.url}: ${e.cause?.code || e.message}`) }
    const text = await res.text()
    if (!res.ok) throw new Error(`ClickHouse ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}`)
    return text
}

/** Run a SELECT; rows come back as objects (64-bit integers as numbers). */
export async function chQuery(c, sql, opts) {
    const text = await chCall(c, { default_format: 'JSONEachRow', output_format_json_quote_64bit_integers: '0', prefer_column_name_to_alias: '1' }, sql, opts)
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}
export const chPing = async (c, opts) => { await chQuery(c, 'SELECT 1 AS ok', opts); return true }

/** Insert rows (objects) into <db>.<table> in batches of c.batch; returns the number inserted. */
export async function chInsert(c, table, rows, opts) {
    if (!CH_WRITABLE.includes(table)) throw new Error(`unknown ClickHouse table ${table}`)
    let n = 0
    for (let i = 0; i < rows.length; i += c.batch) {
        const part = rows.slice(i, i + c.batch)
        await chCall(c, { query: `INSERT INTO ${c.db}.${table} FORMAT JSONEachRow`, date_time_input_format: 'best_effort' }, part.map((r) => JSON.stringify(r)).join('\n'), opts)
        n += part.length
    }
    return n
}
