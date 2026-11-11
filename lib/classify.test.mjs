// Run: node --test lib/classify.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { classify, suggestRepos } from "./classify.mjs"

const known = new Set(["game-arena", "mg-wipeout", "game-zombie-zone"])
const c = (repos, key = "", title = "") => classify(repos, key, title, known)

test("game repo tag wins", () => assert.equal(c("game-arena, dot-core"), "game-arena"))
test("maps repo goes to its game", () => {
    assert.equal(c("mg-wipeout-maps"), "mg-wipeout")
    assert.equal(c("arena-surf-dm-maps"), "game-arena")
})
test("addons are dev, website repos are backbone", () => {
    assert.equal(c("dot-net"), "dev")
    assert.equal(c("zz-modern-weapons"), "dev")
    assert.equal(c("website-city"), "backbone")
    assert.equal(c("~/stack/nightly"), "dev")
})
test("key prefix and title classify untagged items", () => {
    assert.equal(c("", "copter-rot-1", "x"), "mg-smash-copter")
    assert.equal(c("", "chk-sweep", "Sweep: keep every repo healthy"), "dev")
    assert.equal(c("", "x-1", "Browser-verify Admin>Uploads"), "backbone")
    assert.equal(c("all", "stats-1", "Stats: stable key in every game"), "dev")
})
test("genuinely unknown stays other", () => assert.equal(c("", "foo-1", "Get everything up-to-date"), "other"))
test("suggestRepos fills an area slug on create", () => {
    assert.equal(suggestRepos("zz-1", "Zombie zone horde"), "game-zombie-zone")
    assert.equal(suggestRepos("chk-guides", "Write one waiting guide"), "dev")
    assert.equal(suggestRepos("foo-1", "Hello"), "")
})
test("Playlot (renamed from game-playground) files under the checkout's name", () => {
    assert.equal(c("game-playlot"), "game-playground")
    assert.equal(c("game-playlot-maps"), "game-playground")
    assert.equal(c("", "playlot-menu-1", "x"), "game-playground")
    assert.equal(suggestRepos("x-1", "Playlot: fix the spawn menu"), "game-playground")
})
