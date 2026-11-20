// Run: node --test lib/agents.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { DatabaseSync } from "node:sqlite"
import * as S from "./store.mjs"
import * as A from "./agents.mjs"

const R = "host:org/repo"

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
    assert.ok(!o(R + ":a/**", "host:org/other:a/**"))
    assert.ok(!o("host:org/other", R))
    assert.ok(o("host:org", R + ":x"))
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

// fleet-dup-launch-guard-1: an item is not relaunched blind after an agent that committed nothing.
function withItems() {
    const { db } = fresh()
    db.exec(`CREATE TABLE Item (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL DEFAULT 'task');
        CREATE TABLE Note (id INTEGER PRIMARY KEY AUTOINCREMENT, itemId INTEGER NOT NULL, body TEXT NOT NULL, createdAt TEXT NOT NULL);
        INSERT INTO Item (key) VALUES ('zz-survival-nav-1'), ('fc-perf-1'); INSERT INTO Item (key, kind) VALUES ('chk-maps-1', 'check');`)
    return db
}

test("relaunch guard: refuses after a no-commit agent, prints its stop note, --why overrides", () => {
    const db = withItems()
    const old = A.join(db, "nav1", { task: "zz survival navmesh (zz-survival-nav-1)" })
    A.claim(db, old, [R])
    A.leave(db, old, "navmesh bake still hangs, stopped")
    const n = A.join(db, "nav2", { task: "zz-survival-nav-1 again" })
    const r = A.claim(db, n, [R + ":a.gd"])
    assert.ok(!r.ok); assert.equal(r.claimed.length, 0)
    assert.equal(r.relaunch[0].why, "no-commit")
    assert.equal(r.relaunch[0].agent.stopNote, "navmesh bake still hangs, stopped")
    assert.ok(!A.claim(db, n, [R + ":a.gd"], { force: true }).ok, "--force does not pass the relaunch guard")
    const ok = A.claim(db, n, [R + ":a.gd"], { why: "bake moved to a worker thread" })
    assert.ok(ok.ok); assert.deepEqual(ok.claimed, [R + ":a.gd"])
    assert.ok(A.board(db).messages.some((m) => /over the relaunch guard .*bake moved/.test(m.body)))
    assert.ok(A.claim(db, n, [R + ":b.gd"]).ok, "later claims of the same agent are not re-checked")
})

test("relaunch guard: a commit sha in the leave note, a message or an item note passes", () => {
    const db = withItems()
    const a1 = A.join(db, "p1", { task: "perf" }); A.claim(db, a1, [R], { item: "fc-perf-1" }); A.leave(db, a1, "pushed 46d06ab..faddf50")
    assert.ok(A.claim(db, A.join(db, "p2", { task: "fc-perf-1" }), [R]).ok)
    A.leave(db, A.find(db, "p2"))
    // p2 left no note and said nothing, but the item got a note with its commit while it ran
    const db2 = withItems()
    const b1 = A.join(db2, "q1", { task: "fc-perf-1" })
    db2.prepare("INSERT INTO Note (itemId, body, createdAt) VALUES (2, 'landed in 1265144', ?)").run(S.now())
    A.leave(db2, b1)
    assert.ok(A.claim(db2, A.join(db2, "q2", { task: "fc-perf-1" }), [R]).ok)
    const db3 = withItems()
    const c1 = A.join(db3, "r1", { task: "fc-perf-1" }); A.post(db3, c1, "merged abc1234 to main"); A.leave(db3, c1)
    assert.ok(A.claim(db3, A.join(db3, "r2", { task: "fc-perf-1" }), [R]).ok)
})

test("relaunch guard: a live agent on the same item blocks; unrelated or unknown keys do not", () => {
    const db = withItems()
    A.join(db, "live1", { task: "fc-perf-1 bench" })
    const r = A.claim(db, A.join(db, "dup", { task: "fc-perf-1" }), [R + ":x"])
    assert.ok(!r.ok); assert.equal(r.relaunch[0].why, "live")
    assert.ok(A.claim(db, A.join(db, "other", { task: "fc-perf-10 and not-an-item-3" }), [R + ":y"]).ok)
    assert.ok(A.claim(db, A.join(db, "plain", { task: "no key here" }), [R + ":z"]).ok)
    const c1 = A.join(db, "chk1", { task: "chk-maps-1" }); A.leave(db, c1)
    assert.ok(A.claim(db, A.join(db, "chk2", { task: "chk-maps-1" }), [R + ":c"]).ok, "a recurring check is not guarded")
    const it = A.join(db, "named", { task: "bench" })
    assert.ok(!A.claim(db, it, [R + ":w"], { item: "fc-perf-1" }).ok, "--item names the item")
    assert.match(A.find(db, "named").task, /\(fc-perf-1\)$/)
    assert.deepEqual(A.itemKeys(db, "x 46d06ab fc-perf-1."), ["fc-perf-1"])
})

// vjudge-second-review-1 #8: what counts as commit evidence.
test("relaunch guard: sha tokens, slash-joined shas, and shas that are no evidence", () => {
    assert.deepEqual(A.shas("dot-game daad107/faddf50, FC 08330a96"), ["daad107", "faddf50", "08330a96"])
    assert.deepEqual(A.shas("see /tmp/x/a1b2c3d4 and wt/game-x-1117 and deadbeef and v1.2.3456789"), [],
        "paths, short numbers, letter-only and dotted versions are no sha")
    const db = withItems()
    const real = { commitTime: A.evidence.commitTime, repoDirs: A.evidence.repoDirs }
    try {
        A.evidence.repoDirs = () => ["/repo"]
        const t0 = Date.now()
        A.evidence.commitTime = (d, sha) => ({ "0de9e0d": t0 - 86400_000, "62598e3": t0 + 1000 })[sha] ?? null
        const a1 = A.join(db, "s1", { task: "fc-perf-1" }); A.leave(db, a1, "nothing committed, worktree at 0de9e0d")
        const r = A.claim(db, A.join(db, "s2", { task: "fc-perf-1" }), [R])
        assert.ok(!r.ok, "a sha older than the agent is its base, not its commit")
        assert.equal(r.relaunch[0].why, "no-commit")
        const db2 = withItems()
        const b1 = A.join(db2, "t1", { task: "fc-perf-1" }); A.leave(db2, b1, "rebased on 0de9e0d, pushed 62598e3")
        assert.ok(A.claim(db2, A.join(db2, "t2", { task: "fc-perf-1" }), [R]).ok, "a commit made during the run passes")
        const db3 = withItems()
        const c1 = A.join(db3, "u1", { task: "fc-perf-1" }); A.leave(db3, c1, "pushed 7777777 from another clone")
        assert.ok(A.claim(db3, A.join(db3, "u2", { task: "fc-perf-1" }), [R]).ok, "a sha that resolves nowhere counts")
    } finally { Object.assign(A.evidence, real) }
})
