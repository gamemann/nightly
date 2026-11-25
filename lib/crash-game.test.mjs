import test from 'node:test'
import assert from 'node:assert/strict'
import { makeGameOf } from './crash-game.mjs'

const projects = [
    { slug: 'game-fatal-contact', repoPath: '/g/game-fatal-contact', settings: '{"perfGame":"fc"}' },
    { slug: 'game-zombie-zone', repoPath: '/g/game-zombie-zone', settings: { perfGame: 'zz' } },
    { slug: 'mg-wipeout', repoPath: '/g/mg-wipeout', settings: '{}' },
    { slug: 'fc-weapons', repoPath: '/g/fc-weapons', settings: '{}' },
]
const git = { '/h/wt/zzm-burnt': 'gitdir: /g/game-zombie-zone/.git/worktrees/zzm-burnt\n' }
const gameOf = makeGameOf(projects, { readGit: (d) => git[d] ?? '' })

test('inside a project repo', () => assert.equal(gameOf('/g/game-fatal-contact/headless.log'), 'fc'))
test('worktree resolved through its .git file, whatever the dir is called', () => assert.equal(gameOf('/h/wt/zzm-burnt/x.log'), 'zz'))
test('pruned worktree: slug in the dir name, longest slug wins', () => {
    assert.equal(gameOf('/h/wt/wipeout-a1-mg-wipeout/x.log'), 'mg-wipeout')
    assert.equal(gameOf('/h/wt/fc-weapons-pass2/x.log'), 'fc-weapons')
})
test('pruned worktree: perfGame token', () => {
    assert.equal(gameOf('/h/wt/ab-botloop-fc/x.log'), 'fc')
    assert.equal(gameOf('/h/wt/gzz-a1/x.log'), 'unknown')
})
test('host logs and unknowns', () => {
    assert.equal(gameOf('/h/.mlogs/x.log'), 'dev-host')
    assert.equal(gameOf('/tmp/x.log'), 'unknown')
})
