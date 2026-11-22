// Test helper (not a test): an in-memory node:sqlite database with just the tables the RSI code touches.
import { DatabaseSync } from 'node:sqlite'
import { ensure } from './rsi.mjs'

export function memDb() {
    const db = new DatabaseSync(':memory:')
    db.exec(`
CREATE TABLE Item (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'task',
  status TEXT NOT NULL DEFAULT 'queue', priority INTEGER NOT NULL DEFAULT 0, repos TEXT NOT NULL DEFAULT '', doneWhen TEXT, addedBy TEXT NOT NULL DEFAULT 'owner', cadence TEXT, lastRunAt TEXT,
  createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now')), completedAt TEXT);
CREATE TABLE Note (id INTEGER PRIMARY KEY AUTOINCREMENT, itemId INTEGER NOT NULL, runId INTEGER, author TEXT NOT NULL DEFAULT 'owner', body TEXT NOT NULL, createdAt TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE Setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE AssetWeapon (id INTEGER PRIMARY KEY AUTOINCREMENT, pack TEXT NOT NULL, weaponId TEXT NOT NULL);`)
    ensure(db)
    return db
}
export const addItem = (db, o) => db.prepare('INSERT INTO Item (key, title, body, status, kind, addedBy, updatedAt) VALUES (?,?,?,?,?,?,?)')
    .run(o.key, o.title ?? o.key, o.body ?? '', o.status ?? 'queue', o.kind ?? 'task', o.addedBy ?? 'agent', o.updatedAt ?? new Date().toISOString())
