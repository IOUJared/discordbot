import assert from "node:assert/strict"
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { withRetentionFixture } from "./media-sidecar-retention-test-support.mjs"

const treeSnapshot = (root, relative = "") => {
  const result = {}
  for (const name of readdirSync(join(root, relative)).sort()) {
    const child = join(relative, name)
    const path = join(root, child)
    if (statSync(path).isDirectory()) {
      result[`${child}/`] = "directory"
      Object.assign(result, treeSnapshot(root, child))
    } else {
      result[child] = readFileSync(path).toString("base64")
    }
  }
  return result
}

const snapshot = (fixture) => ({
  backup: treeSnapshot(fixture.backup),
  compose: fixture.read(fixture.config),
  environment: fixture.read(fixture.envFile),
  docker: fixture.read(fixture.dockerMutations),
  volume: fixture.read(fixture.volumeMarker),
})

const rejectedLeases = [
  ["active", (lease) => Object.assign(lease, { state: "active", restoreState: "idle" })],
  ["fencing", (lease) => Object.assign(lease, { state: "expired", restoreState: "fencing" })],
  ["restoring", (lease) => Object.assign(lease, { state: "expired", restoreState: "restoring" })],
  [
    "expired but not restored",
    (lease) => Object.assign(lease, { state: "expired", restoreState: "idle" }),
  ],
  ["malformed", (_lease, fixture) => fixture.write(fixture.lease, "{")],
  [
    "duplicate member",
    (_lease, fixture) =>
      fixture.write(
        fixture.lease,
        fixture.read(fixture.lease).replace("{", '{"state":"committed",'),
      ),
  ],
  ["wrong-type discriminator", (lease) => Object.assign(lease, { generation: "99" })],
]

for (const [name, mutate] of rejectedLeases) {
  test(`begin-run rejects ${name} lease before any owner mutation`, () => {
    withRetentionFixture((fixture) => {
      fixture.addArchive({ generation: 1 })
      const lease = fixture.setLease(fixture.initialCurrent)
      mutate(lease, fixture)
      if (!["malformed", "duplicate member"].includes(name))
        fixture.write(fixture.lease, JSON.stringify(lease))
      const before = snapshot(fixture)

      const result = fixture.invoke()

      assert.equal(result.status, 1, result.stderr)
      assert.deepEqual(snapshot(fixture), before)
    })
  })
}

test("begin-run rejects a symlinked current checkpoint before mutation", () => {
  withRetentionFixture((fixture) => {
    const expired = fixture.addArchive({ generation: 1 })
    const sentinel = fixture.replaceCurrentWithSymlink()
    const before = snapshot(fixture)

    const result = fixture.invoke()

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /prior-checkpoint-invalid/u)
    assert.deepEqual(snapshot(fixture), before)
    assert.equal(fixture.read(join(sentinel, "untouched")), "sentinel\n")
    assert.equal(fixture.exists(expired.run), true)
  })
})

test("begin-run rejects a wrong-mode current checkpoint before mutation", () => {
  withRetentionFixture((fixture) => {
    const expired = fixture.addArchive({ generation: 1 })
    chmodSync(fixture.initialCurrent.run, 0o755)
    const before = snapshot(fixture)

    const result = fixture.invoke()

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /prior-checkpoint-invalid/u)
    assert.deepEqual(snapshot(fixture), before)
    assert.equal(fixture.exists(expired.run), true)
  })
})

test("begin-run detects lease pathname replacement at the Docker boundary", () => {
  withRetentionFixture((fixture) => {
    const expired = fixture.addArchive({ generation: 1 })
    const replacement = JSON.stringify({ replaced: true })
    const before = snapshot(fixture)

    const result = fixture.invoke(fixture.replaceLeaseDuringDocker(replacement))

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /lease-replaced/u)
    assert.equal(fixture.read(fixture.lease), replacement)
    assert.equal(fixture.read(fixture.counter), "99\n")
    assert.equal(fixture.exists(expired.run), true)
    assert.equal(fixture.read(fixture.dockerMutations), before.docker)
    assert.equal(fixture.read(fixture.config), before.compose)
    assert.equal(fixture.read(fixture.envFile), before.environment)
    assert.equal(fixture.read(fixture.volumeMarker), before.volume)
    assert.equal(fixture.exists(fixture.replacementMarker), true)
  })
})

for (const state of ["committed", "expired"]) {
  test(`begin-run accepts valid ${state} terminal lease exactly once`, () => {
    withRetentionFixture((fixture) => {
      const expired = fixture.addArchive({ generation: 1 })
      const prior = fixture.addArchive({ generation: 98, state, ageMs: 60_000 })
      const priorLease = JSON.stringify(fixture.setLease(prior))
      rmSync(join(prior.run, "terminal.json"))

      const result = fixture.invoke()

      assert.equal(result.status, 0, result.stderr)
      assert.equal(existsSync(expired.run), false)
      assert.equal(fixture.read(fixture.counter), "100\n")
      assert.equal(fixture.read(join(prior.run, "terminal.json")), priorLease)
      const lease = JSON.parse(fixture.read(fixture.lease))
      assert.equal(lease.generation, 100)
      assert.equal(lease.state, "active")
      assert.equal(lease.restoreState, "idle")
      assert.equal(readdirSync(fixture.backup).filter((name) => name.startsWith("100-")).length, 1)
      const mutations = fixture.read(fixture.dockerMutations)
      assert.match(mutations, /image rm discord-music-rollback:1-/u)
      assert.doesNotMatch(mutations, /(container|volume) rm|image tag/u)
      assert.equal(fixture.read(fixture.volumeMarker), "unchanged\n")
    })
  })
}
