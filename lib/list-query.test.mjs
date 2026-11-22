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
