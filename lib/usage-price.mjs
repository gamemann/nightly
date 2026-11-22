// Token prices for the Usage tab: USD per million tokens, per model, kept in the `usagePrices` setting (JSON, edited in the panel).
// These are ESTIMATES: list prices change, plans and discounts differ, and a subscription is not billed per token at all.
// The defaults are generic family prices, nothing more; set your own per model.
export const KINDS = ['input', 'output', 'cache_read', 'cache_5m', 'cache_1h']

/** Keys are matched as a case-insensitive substring of the model id, longest key first; '*' is the fallback. */
export const DEFAULT_PRICES = {
    opus: { input: 5, output: 25, cache_read: 0.5, cache_5m: 6.25, cache_1h: 10 },
    sonnet: { input: 3, output: 15, cache_read: 0.3, cache_5m: 3.75, cache_1h: 6 },
    haiku: { input: 1, output: 5, cache_read: 0.1, cache_5m: 1.25, cache_1h: 2 },
    '*': { input: 3, output: 15, cache_read: 0.3, cache_5m: 3.75, cache_1h: 6 },
}

/** Read the setting's JSON; anything malformed or non-numeric is an error, never a silent default. */
export function parsePrices(text) {
    if (text === null || text === undefined || String(text).trim() === '') return structuredClone(DEFAULT_PRICES)
    let o
    try { o = JSON.parse(text) } catch (e) { throw new Error(`usagePrices is not valid JSON: ${e.message}`) }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('usagePrices must be a JSON object: {"model-substring": {"input": 3, ...}}')
    for (const [m, p] of Object.entries(o)) for (const k of KINDS) {
        const v = p?.[k]
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`usagePrices["${m}"].${k} must be a number >= 0 (USD per million tokens)`)
    }
    return o
}

/** The price row for a model id, plus whether it was a real match (not the fallback). */
export function priceFor(prices, model) {
    const m = String(model || '').toLowerCase()
    const key = Object.keys(prices).filter((k) => k !== '*' && m.includes(k.toLowerCase())).sort((a, b) => b.length - a.length)[0]
    if (key) return { price: prices[key], matched: key }
    return { price: prices['*'] ?? DEFAULT_PRICES['*'], matched: '' }
}

/** Estimated USD for a token tally { input, output, cache_read, cache_5m, cache_1h } on one model. */
export function cost(prices, model, t) {
    const { price } = priceFor(prices, model)
    let usd = 0
    for (const k of KINDS) usd += ((Number(t[k]) || 0) * price[k]) / 1e6
    return usd
}
