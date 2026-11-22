import test from 'node:test'
import assert from 'node:assert/strict'
import { filterReviews, filterWeapons, REVIEW_SORTS } from './review-list.mjs'

const rev = (key, title, game, good, wrong, todo, updatedAt = '2026-11-01') => ({ key, title, game, createdAt: updatedAt, updatedAt, counts: { total: good + wrong + todo, good, wrong, todo } })
const ALL = [rev('a', 'Alpha Rifle', 'fc', 2, 0, 0, '2026-11-03'), rev('b', 'Beta sounds', 'fc', 0, 1, 3, '2026-11-05'), rev('c', 'Gamma', 'ad', 0, 0, 4, '2026-11-04')]
const keys = (l) => l.map((r) => r.key)

test('filterReviews defaults to newest update first', () => {
    assert.deepEqual(keys(filterReviews(ALL)), ['b', 'c', 'a'])
})
test('filterReviews filters by game, state and search (title or key, case-insensitive)', () => {
    assert.deepEqual(keys(filterReviews(ALL, { game: 'fc' })), ['b', 'a'])
    assert.deepEqual(keys(filterReviews(ALL, { state: 'todo' })), ['b', 'c'])
    assert.deepEqual(keys(filterReviews(ALL, { state: 'good' })), ['a'])
    assert.deepEqual(keys(filterReviews(ALL, { q: ' ALPHA ' })), ['a'])
    assert.deepEqual(keys(filterReviews(ALL, { q: 'c' })), ['c'])
    assert.deepEqual(filterReviews(ALL, { q: 'nothing' }), [])
})
test('filterReviews sorts by progress, entries, title; unknown sort falls back to updated', () => {
    assert.deepEqual(keys(filterReviews(ALL, { sort: 'progress', dir: 'desc' })), ['a', 'b', 'c'])
    assert.deepEqual(keys(filterReviews(ALL, { sort: 'entries', dir: 'asc' })), ['a', 'b', 'c'])
    assert.deepEqual(keys(filterReviews(ALL, { sort: 'title', dir: 'desc' })), ['c', 'b', 'a'])
    assert.deepEqual(keys(filterReviews(ALL, { sort: 'bogus' })), ['b', 'c', 'a'])
    assert.ok(REVIEW_SORTS.includes('progress'))
})
test('filterReviews does not mutate its input', () => {
    const copy = [...ALL]
    filterReviews(ALL, { sort: 'title' })
    assert.deepEqual(ALL, copy)
})

const W = [{ id: 'm4', w: { title: 'Carbine', verdict: 'good' } }, { id: 'ak', w: { title: 'Rifle' } }, { id: 'pk', w: { title: 'Pistol', verdict: 'wrong' } }]
test('filterWeapons searches id and title, filters verdicts, sorts by id', () => {
    assert.deepEqual(filterWeapons(W).map((r) => r.id), ['ak', 'm4', 'pk'])
    assert.deepEqual(filterWeapons(W, { dir: 'desc' }).map((r) => r.id), ['pk', 'm4', 'ak'])
    assert.deepEqual(filterWeapons(W, { verdict: 'todo' }).map((r) => r.id), ['ak'])
    assert.deepEqual(filterWeapons(W, { verdict: 'wrong' }).map((r) => r.id), ['pk'])
    assert.deepEqual(filterWeapons(W, { q: 'RIFLE' }).map((r) => r.id), ['ak'])
    assert.deepEqual(filterWeapons(W, { q: 'm4', verdict: 'wrong' }), [])
})
