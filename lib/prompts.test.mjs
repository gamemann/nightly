// Run: node --test lib/prompts.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as P from './prompts.mjs'
import { memDb } from './testdb.mjs'

const mk = () => {
    const db = memDb()
    db.exec('CREATE TABLE IF NOT EXISTS Prompt (id INTEGER PRIMARY KEY, name TEXT UNIQUE, kind TEXT, body TEXT, createdAt TEXT, updatedAt TEXT)')
    db.exec('CREATE TABLE IF NOT EXISTS PromptVersion (id INTEGER PRIMARY KEY, promptId INTEGER, body TEXT, author TEXT, note TEXT, createdAt TEXT)')
    db.exec('CREATE TABLE IF NOT EXISTS Schedule (id INTEGER PRIMARY KEY, name TEXT, prompt TEXT)')
    return db
}
test('rename keeps id and history, moves schedules, can reclassify', () => {
    const db = mk()
    P.set(db, 'gate.md', '#!/usr/bin/env bash\nexit 0\n', { kind: 'prompt' })
    db.prepare("INSERT INTO Schedule (name, prompt) VALUES ('s','gate.md')").run()
    const id = P.get(db, 'gate.md').id
    const r = P.rename(db, 'gate.md', 'gate.sh', { kind: 'script' })
    assert.deepEqual([r.id, r.schedules, r.kind], [id, 1, 'script'])
    assert.equal(P.get(db, 'gate.md'), undefined)
    assert.equal(P.history(db, 'gate.sh').length, 1)
    assert.equal(db.prepare('SELECT prompt FROM Schedule').get().prompt, 'gate.sh')
})
test('rename refuses a taken or bad name', () => {
    const db = mk()
    P.set(db, 'a.sh', 'x'); P.set(db, 'b.sh', 'y')
    assert.throws(() => P.rename(db, 'a.sh', 'b.sh'), /already exists/)
    assert.throws(() => P.rename(db, 'a.sh', 'bad name'), /prompt name/)
})
