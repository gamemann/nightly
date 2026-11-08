// Run: node --test lib/agents.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as S from "./store.mjs"
import * as A from "./agents.mjs"

const R = "dev02:godot/game-arena"

test("splitScope", () => {
    assert.deepEqual(A.splitScope(R), { repo: R, path: "" })
    assert.deepEqual(A.splitScope(R + ":scripts/ctf/**"), { repo: R, path: "scripts/ctf/**" })
    assert.deepEqual(A.splitScope("godot/game-arena:a/b"), { repo: "godot/game-arena", path: "a/b" })
    assert.deepEqual(A.splitScope("godot/game-arena"), { repo: "godot/game-arena", path: "" })
})

test("overlaps: bare repo vs scoped, scoped vs scoped", () => {
    const o = A.overlaps
    assert.ok(o(R, R + ":scripts/ctf/**"))
    assert.ok(o(R + ":scripts/ctf/**", R))
    assert.ok(o(R, R))
    assert.ok(!o(R + ":scripts/ctf/**", R + ":scripts/ui/**"))
    assert.ok(o(R + ":scripts/**", R + ":scripts/ui/a.gd"))
    assert.ok(o(R + ":scripts/ctf/a.gd", R + ":scripts/ctf/a.gd"))
    assert.ok(!o(R + ":scripts/ctf/a.gd", R + ":scripts/ctf/b.gd"))
    assert.ok(o(R + ":scripts", R + ":scripts/ctf/b.gd"))
    assert.ok(!o(R + ":scripts/*.gd", R + ":scripts/ctf/b.gd"))
    assert.ok(o(R + ":scripts/*.gd", R + ":scripts/b.gd"))
    assert.ok(!o(R + ":scripts/*.gd", R + ":scripts/b.tscn"))
    assert.ok(o(R + ":scripts/**/*.gd", R + ":scripts/ctf/**"))
    assert.ok(!o(R + ":a/**", "dev02:godot/other:a/**"))
    assert.ok(!o("dev02:godot/other", R))
    assert.ok(o("dev02:godot", R + ":x"))
})

function fresh() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claims-"))
    const file = path.join(dir, "t.db")
    const db = new DatabaseSync(file)
    db.exec(`CREATE TABLE Agent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'session', task TEXT NOT NULL DEFAULT '', repos TEXT NOT NULL DEFAULT '', runId INTEGER, lastReadId INTEGER NOT NULL DEFAULT 0, startedAt TEXT NOT NULL, lastSeenAt TEXT NOT NULL, endedAt TEXT);
        CREATE TABLE Claim (id INTEGER PRIMARY KEY AUTOINCREMENT, agentId INTEGER NOT NULL, scope TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, releasedAt TEXT);
        CREATE TABLE Message (id INTEGER PRIMARY KEY AUTOINCREMENT, agentId INTEGER, author TEXT NOT NULL, "to" TEXT, body TEXT NOT NULL, createdAt TEXT NOT NULL);`)
    return { db, a: A.join(db, "a"), b: A.join(db, "b") }
}

test("claim/release/leave with scoped claims", () => {
    const { db, a, b } = fresh()
    assert.ok(A.claim(db, a, [R + ":scripts/ctf/**"]).ok)
    assert.ok(A.claim(db, b, [R + ":scripts/ui/**"]).ok, "disjoint paths coexist")
    const r = A.claim(db, b, [R + ":scripts/ctf/x.gd"])
    assert.ok(!r.ok); assert.equal(r.blocking[0].name, "a")
    assert.ok(!A.claim(db, b, [R]).ok, "bare repo conflicts with scoped holders")
    assert.deepEqual(A.release(db, b, [R + ":scripts/ui/**"]), [R + ":scripts/ui/**"])
    assert.ok(A.release(db, a, [R + ":scripts/ctf/**"]).length === 1)
    assert.ok(A.claim(db, b, [R]).ok)
    assert.ok(!A.claim(db, a, [R + ":scripts/ctf/**"]).ok, "bare repo claim blocks scoped")
    assert.deepEqual(A.leave(db, b), [R])
    assert.ok(A.claim(db, a, [R + ":scripts/ctf/**"]).ok)
    assert.ok(A.board(db).claims.some((c) => c.scope === R + ":scripts/ctf/**"), "board shows the path")
})
