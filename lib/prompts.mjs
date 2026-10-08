// Prompts and the runner script, stored in the database (see Prompt in prisma/schema.prisma).
// Every change keeps the new body as a PromptVersion, so the history git used to hold stays.
import * as S from './store.mjs'

export const PROMPT_KINDS = ['prompt', 'script']
export const RUNNER_SCRIPT = 'run.sh'

const NAME = /^[\w.-]{1,80}$/

export const list = (db) =>
    db.prepare('SELECT id, name, kind, length(body) size, updatedAt FROM Prompt ORDER BY kind, name').all()

export const get = (db, name) => db.prepare('SELECT * FROM Prompt WHERE name = ?').get(name)

export function must(db, name) {
    const p = get(db, name)
    if (!p) throw new Error(`no prompt "${name}" (nightly prompt list)`)
    return p
}

/** Create or replace a prompt's body. Unchanged text records nothing. Returns { prompt, changed }. */
export function set(db, name, body, { kind, author = 'christian', note = '', at } = {}) {
    if (!NAME.test(name)) throw new Error('prompt name: letters, digits, . _ - (e.g. nightly.md)')
    if (kind && !PROMPT_KINDS.includes(kind)) throw new Error(`bad kind "${kind}" (one of: ${PROMPT_KINDS.join(', ')})`)
    return S.tx(db, () => {
        const t = at ?? S.now()
        let p = get(db, name)
        if (p && p.body === body && (!kind || kind === p.kind)) return { prompt: p, changed: false }
        if (p) {
            db.prepare('UPDATE Prompt SET body = ?, kind = ?, updatedAt = ? WHERE id = ?').run(body, kind ?? p.kind, t, p.id)
        } else {
            const k = kind ?? (name.endsWith('.md') ? 'prompt' : 'script')
            p = { id: Number(db.prepare('INSERT INTO Prompt (name, kind, body, createdAt, updatedAt) VALUES (?,?,?,?,?)').run(name, k, body, t, t).lastInsertRowid) }
        }
        if (!p.body || p.body !== body) {
            db.prepare('INSERT INTO PromptVersion (promptId, body, author, note, createdAt) VALUES (?,?,?,?,?)').run(p.id, body, author, note, t)
        }
        return { prompt: get(db, name), changed: true }
    })
}

export const history = (db, name) =>
    db.prepare('SELECT id, author, note, createdAt, length(body) size FROM PromptVersion WHERE promptId = ? ORDER BY createdAt DESC, id DESC')
        .all(must(db, name).id)

export const version = (db, id) => db.prepare('SELECT * FROM PromptVersion WHERE id = ?').get(id)
