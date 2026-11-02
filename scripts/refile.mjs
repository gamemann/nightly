#!/usr/bin/env node
// Re-file items with no repos: fill Item.repos from the key/title (lib/classify.mjs).
// Usage: scripts/refile.mjs [--apply] [--undo FILE]. Dry run by default; --apply writes an undo list
// (key, old repos, new repos) to data/backup/refile-<time>.tsv; --undo FILE restores it. Never deletes items.
import { DatabaseSync } from "node:sqlite"
import { readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { classify, suggestRepos } from "../lib/classify.mjs"

const db = new DatabaseSync(process.env.NIGHTLY_DB || new URL("../data/nightly.db", import.meta.url).pathname)
const args = process.argv.slice(2)
if (args[0] === "--undo") {
    const up = db.prepare("UPDATE Item SET repos=? WHERE key=? AND repos=?")
    let n = 0
    for (const l of readFileSync(args[1], "utf8").split("\n").filter(Boolean)) { const [k, o, nw] = l.split("\t"); n += Number(up.run(o, k, nw).changes) }
    console.log(`restored ${n}`); process.exit(0)
}
const rows = db.prepare("SELECT key, title, repos, status FROM Item").all()
const known = new Set()
for (const r of rows) for (const t of r.repos.split(",")) { const n = t.trim().split("/").pop(); if (/^(game|mg)-/.test(n)) known.add(n) }
const tally = (f) => { const c = {}; for (const r of rows) { const s = f(r); c[s] = (c[s] || 0) + 1 } return c }
const before = tally((r) => (/^(game|mg)-/.test(r.repos) || r.repos ? classifyOld(r) : "other"))
function classifyOld(r) { return classify(r.repos, "", "", known) }
const changes = rows.filter((r) => !r.repos.trim()).map((r) => ({ key: r.key, old: r.repos, nw: suggestRepos(r.key, r.title), title: r.title })).filter((c) => c.nw)
const after = tally((r) => { const c = changes.find((x) => x.key === r.key); return classify(c ? c.nw : r.repos, r.key, r.title, known) })
const afterNoChange = tally((r) => classify(r.repos, r.key, r.title, known))
console.log("before (repos only):", JSON.stringify(Object.entries(before).sort((a, b) => b[1] - a[1])))
console.log("after (classifier at read time):", JSON.stringify(Object.entries(afterNoChange).sort((a, b) => b[1] - a[1])))
console.log("after (repos refiled + classifier):", JSON.stringify(Object.entries(after).sort((a, b) => b[1] - a[1])))
console.log(`${changes.length} items with empty repos get repos written`)
for (const c of changes) console.log(`${c.key}\t-> ${c.nw}`)
if (args[0] === "--apply") {
    mkdirSync(new URL("../data/backup/", import.meta.url).pathname, { recursive: true })
    const f = new URL(`../data/backup/refile-${new Date().toISOString().replace(/[:.]/g, "-")}.tsv`, import.meta.url).pathname
    writeFileSync(f, changes.map((c) => [c.key, c.old, c.nw].join("\t")).join("\n") + "\n")
    const up = db.prepare("UPDATE Item SET repos=? WHERE key=? AND repos=?")
    for (const c of changes) up.run(c.nw, c.key, c.old)
    console.log("applied; undo list:", f)
}
