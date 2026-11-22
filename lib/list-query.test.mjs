import test from 'node:test'
import assert from 'node:assert/strict'
import { promptsQuery, runsQuery, RUN_SORTS } from './list-query.mjs'

test('runsQuery scopes by game and only the given scope keys', () => {
    assert.deepEqual(runsQuery({ game: 'fc' }).where, { game: 'fc' })
    assert.deepEqual(runsQuery({ game: 'fc', platform: 'web', map: '', bots: 0 }).where, { game: 'fc', platform: 'web', map: '', bots: 0 })
})
test('runsQuery searches commit, label, name and map with the trimmed text', () => {
    const { where } = runsQuery({ game: 'fc', q: '  ab12 ' })
    assert.deepEqual(where.OR.map((c) => Object.keys(c)[0]), ['commit', 'label', 'name', 'map'])
    assert.equal(where.OR[0].commit.contains, 'ab12')
    assert.equal(runsQuery({ game: 'fc', q: '   ' }).where.OR, undefined)
})
test('runsQuery whitelists the sort, defaults to newest first and ties on id', () => {
    assert.deepEqual(runsQuery({ game: 'fc' }).orderBy, [{ ranAt: 'desc' }, { id: 'desc' }])
    assert.deepEqual(runsQuery({ game: 'fc', sort: 'commit', dir: 'asc' }).orderBy, [{ commit: 'asc' }, { id: 'desc' }])
    assert.deepEqual(runsQuery({ game: 'fc', sort: 'password; drop', dir: 'asc' }).orderBy, [{ ranAt: 'asc' }, { id: 'desc' }])
    assert.ok(RUN_SORTS.includes('ranAt'))
})
test('promptsQuery: kind, name-or-text search, name ascending unless the URL sorts', () => {
    const d = promptsQuery({ kind: 'prompt' })
    assert.deepEqual(d.where, { kind: 'prompt' })
    assert.deepEqual(d.orderBy, [{ name: 'asc' }, { id: 'asc' }])
    assert.deepEqual(promptsQuery({ kind: 'script', q: 'x' }).where.OR, [{ name: { contains: 'x' } }, { body: { contains: 'x' } }])
    assert.deepEqual(promptsQuery({ kind: 'prompt', sort: 'updatedAt', dir: 'desc' }).orderBy, [{ updatedAt: 'desc' }, { id: 'asc' }])
    assert.deepEqual(promptsQuery({ kind: 'prompt', sort: 'bogus', dir: 'desc' }).orderBy, [{ name: 'desc' }, { id: 'asc' }])
    assert.deepEqual(promptsQuery({ kind: 'prompt', dir: 'desc' }).orderBy, [{ name: 'asc' }, { id: 'asc' }])
})
test('pageList: search, whitelisted sort, facet filter, paging, stable ties', async () => {
    const { pageList } = await import('./list-query.mjs')
    const items = [{ n: 'beta', g: 'fc', k: 2 }, { n: 'Alpha', g: 'fc', k: 2 }, { n: 'gamma', g: 'x', k: 9 }]
    const spec = { search: ['n'], sorts: { n: (r) => r.n.toLowerCase(), k: (r) => r.k }, filters: { g: (r) => r.g }, fallback: 'n' }
    assert.deepEqual(pageList(items, {}, spec).rows.map((r) => r.n), ['Alpha', 'beta', 'gamma'])
    assert.deepEqual(pageList(items, { sort: 'k', dir: 'desc' }, spec).rows.map((r) => r.n), ['gamma', 'beta', 'Alpha'])
    assert.deepEqual(pageList(items, { sort: 'bogus' }, spec).rows.map((r) => r.n), ['Alpha', 'beta', 'gamma'])
    assert.deepEqual(pageList(items, { q: ' ALP ' }, spec), { rows: [items[1]], total: 1 })
    assert.equal(pageList(items, { f: { g: 'fc' } }, spec).total, 2)
    assert.deepEqual(pageList(items, { page: 9, size: 2 }, spec), { rows: [items[2]], total: 3 })
})
