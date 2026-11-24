// Run: node --test lib/classify.test.mjs
import { test } from "node:test"
import assert from "node:assert/strict"
import { classify, suggestRepos } from "./classify.mjs"
import { readFileSync } from "node:fs"
import { setRules } from "./naming-rules.mjs"
setRules(readFileSync(new URL("./naming-rules.fixture.json", import.meta.url), "utf8"))   // a sample workspace's rules (the live ones are the namingRules setting)

const known = new Set(["game-fatal-contact", "mg-wipeout", "game-zombie-zone"])
const c = (repos, key = "", title = "") => classify(repos, key, title, known)

test("game repo tag wins", () => assert.equal(c("game-fatal-contact, dot-core"), "game-fatal-contact"))
test("maps repo goes to its game", () => {
    assert.equal(c("mg-wipeout-maps"), "mg-wipeout")
    assert.equal(c("arena-surf-dm-maps"), "game-fatal-contact")
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
test("Playlot files under game-playlot; old-name repo tags still file there", () => {
    assert.equal(c("game-playlot"), "game-playlot")
    assert.equal(c("playlot-maps"), "game-playlot")
    assert.equal(c("game-playlot-maps"), "game-playlot")
    assert.equal(c("", "playlot-menu-1", "x"), "game-playlot")
    assert.equal(suggestRepos("x-1", "Playlot: fix the spawn menu"), "game-playlot")
    // Items filed before the rename keep the old checkout names in Item.repos.
    assert.equal(c("game-playground"), "game-playlot")
    assert.equal(c("game-playground-maps"), "game-playlot")
    assert.equal(c("godot/game-playground, dot-core"), "game-playlot")
    assert.equal(c("", "pg-spawn-1", "x"), "game-playlot")
})

test("Airdrift files under game-airdrift; old-name repo tags still file there", () => {
    assert.equal(c("game-airdrift"), "game-airdrift")
    assert.equal(c("airdrift-maps"), "game-airdrift")
    assert.equal(c("", "airdrift-surf-1", "x"), "game-airdrift")
    assert.equal(suggestRepos("x-1", "Airdrift: fix the replay bot"), "game-airdrift")
})

test("Fatal Contact files under game-fatal-contact", () => {
    assert.equal(c("game-fatalcontact"), "game-fatal-contact")
    assert.equal(c("game-fatal-contact"), "game-fatal-contact")
    assert.equal(c("fc-weapons"), "game-fatal-contact")
    assert.equal(c("zees-games/fc-surf-dm-maps"), "game-fatal-contact")
    assert.equal(c("", "fatalcontact-ctf-1", "x"), "game-fatal-contact")
    assert.equal(suggestRepos("x-1", "Fatal Contact: fix the scoreboard"), "game-fatal-contact")
})
