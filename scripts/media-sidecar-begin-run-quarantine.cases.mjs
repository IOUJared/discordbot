import assert from "node:assert/strict"
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { withRetentionFixture } from "./media-sidecar-retention-test-support.mjs"

const runId = (generation, character) => `${generation}-${character.repeat(32)}`
const tempPath = (fixture, generation, character) =>
  join(fixture.backup, `.${runId(generation, character)}.tmp`)
const quarantines = (fixture) =>
  readdirSync(fixture.backup).filter((name) => name.startsWith(".begin-quarantine."))
const mkdir = (path, mode = 0o700) => {
  mkdirSync(path, { mode })
  chmodSync(path, mode)
}
const baseline = (fixture) => ({
  counter: fixture.read(fixture.counter),
  docker: fixture.read(fixture.dockerMutations),
  lease: fixture.read(fixture.lease),
  volume: fixture.read(fixture.volumeMarker),
})
const assertBaseline = (fixture, before) => {
  assert.equal(fixture.read(fixture.counter), before.counter)
  assert.equal(fixture.read(fixture.dockerMutations), before.docker)
  assert.equal(fixture.read(fixture.lease), before.lease)
  assert.equal(fixture.read(fixture.volumeMarker), before.volume)
}

test("failed quarantine rename leaves the original temp and counter unchanged", () => {
  withRetentionFixture((fixture) => {
    const temp = tempPath(fixture, 100, "a")
    mkdir(temp)
    const before = baseline(fixture)

    const result = fixture.invoke({ MEDIA_OWNER_TEST_FAIL_RECOVERY_PHASE: "quarantine-rename" })

    assert.equal(result.status, 1)
    assertBaseline(fixture, before)
    assert.equal(fixture.exists(temp), true)
    assert.deepEqual(quarantines(fixture), [])
  })
})

test("failed second quarantine rename rolls every temp back before counter advance", () => {
  withRetentionFixture((fixture) => {
    const first = tempPath(fixture, 100, "a")
    const second = tempPath(fixture, 105, "b")
    mkdir(first)
    mkdir(second)
    const before = baseline(fixture)

    const result = fixture.invoke({
      MEDIA_OWNER_TEST_FAIL_RECOVERY_PHASE: "quarantine-second-rename",
    })

    assert.equal(result.status, 1)
    assertBaseline(fixture, before)
    assert.equal(fixture.exists(first), true)
    assert.equal(fixture.exists(second), true)
    assert.deepEqual(quarantines(fixture), [])
  })
})

test("unreadable nested content is quarantined opaquely and retained", () => {
  withRetentionFixture((fixture) => {
    const temp = tempPath(fixture, 100, "a")
    const inaccessible = join(temp, "inaccessible")
    mkdir(temp)
    mkdir(inaccessible, 0o000)

    try {
      const result = fixture.invoke()

      assert.equal(result.status, 0, result.stderr)
      assert.equal(fixture.exists(temp), false)
      assert.equal(quarantines(fixture).length, 1)
      assert.equal(fixture.read(fixture.counter), "101\n")
    } finally {
      const retained = quarantines(fixture).at(0)
      chmodSync(retained ? join(fixture.backup, retained, "inaccessible") : inaccessible, 0o700)
    }
  })
})

test("nested symlink target is never followed during quarantine", () => {
  withRetentionFixture((fixture) => {
    const temp = tempPath(fixture, 100, "a")
    const outside = join(dirname(fixture.backup), "outside-quarantine")
    mkdir(temp)
    mkdir(outside)
    writeFileSync(join(outside, "sentinel"), "untouched\n")
    symlinkSync(outside, join(temp, "nested-link"))

    const result = fixture.invoke()

    assert.equal(result.status, 0, result.stderr)
    assert.equal(fixture.read(join(outside, "sentinel")), "untouched\n")
    assert.equal(quarantines(fixture).length, 1)
  })
})

test("all simultaneous temps are quarantined before the counter advances", () => {
  withRetentionFixture((fixture) => {
    const first = tempPath(fixture, 100, "a")
    const second = tempPath(fixture, 105, "b")
    mkdir(first)
    mkdir(second)
    writeFileSync(join(first, "partial"), "first\n")
    writeFileSync(join(second, "partial"), "second\n")

    const result = fixture.invoke()

    assert.equal(result.status, 0, result.stderr)
    assert.equal(fixture.exists(first), false)
    assert.equal(fixture.exists(second), false)
    assert.equal(quarantines(fixture).length, 2)
    assert.equal(JSON.parse(fixture.read(fixture.lease)).generation, 106)
  })
})

for (const [phase, expectedCounter] of [
  ["recovery-quarantine-rename", "99\n"],
  ["recovery-counter-fsync", "100\n"],
]) {
  test(`SIGKILL at ${phase} recovers without generation reuse`, () => {
    withRetentionFixture((fixture) => {
      const temp = tempPath(fixture, 100, "a")
      mkdir(temp)
      const before = baseline(fixture)

      const killed = fixture.invoke(fixture.killAtPhase(phase))

      assert.equal(killed.signal, "SIGKILL")
      assert.equal(fixture.read(fixture.counter), expectedCounter)
      assert.equal(fixture.exists(temp), false)
      assert.equal(quarantines(fixture).length, 1)
      assert.equal(fixture.read(fixture.lease), before.lease)
      assert.equal(fixture.read(fixture.dockerMutations), before.docker)

      const recovered = fixture.invoke()
      assert.equal(recovered.status, 0, recovered.stderr)
      assert.equal(JSON.parse(fixture.read(fixture.lease)).generation, 101)
      assert.equal(fixture.read(fixture.counter), "101\n")
      assert.equal(quarantines(fixture).length, 0)
    })
  })
}

test("duplicate pending marker members fail closed before quarantine", () => {
  withRetentionFixture((fixture) => {
    const temp = tempPath(fixture, 100, "a")
    mkdir(temp)
    writeFileSync(
      join(temp, ".begin-pending"),
      `{"schema":"discord-music-begin-pending.v1","schema":"discord-music-begin-pending.v1","runId":"${runId(100, "a")}","generation":100,"priorRunId":null}`,
    )
    chmodSync(join(temp, ".begin-pending"), 0o600)
    const before = baseline(fixture)

    const result = fixture.invoke()

    assert.equal(result.status, 1)
    assertBaseline(fixture, before)
    assert.equal(fixture.exists(temp), true)
    assert.deepEqual(quarantines(fixture), [])
  })
})

test("invalid pre-existing quarantine fails closed before mutation", () => {
  withRetentionFixture((fixture) => {
    const path = join(fixture.backup, `.begin-quarantine.${runId(100, "a")}.b${"b".repeat(31)}`)
    mkdir(path, 0o755)
    const before = baseline(fixture)

    const result = fixture.invoke()

    assert.equal(result.status, 1)
    assertBaseline(fixture, before)
    assert.equal(fixture.exists(path), true)
  })
})

test("symlinked quarantine fails closed without touching its target", () => {
  withRetentionFixture((fixture) => {
    const outside = join(dirname(fixture.backup), "outside-existing-quarantine")
    const name = `.begin-quarantine.${runId(100, "a")}.${"b".repeat(32)}`
    mkdir(outside)
    writeFileSync(join(outside, "sentinel"), "untouched\n")
    symlinkSync(outside, join(fixture.backup, name))
    const before = baseline(fixture)

    const result = fixture.invoke()

    assert.equal(result.status, 1)
    assertBaseline(fixture, before)
    assert.equal(fixture.read(join(outside, "sentinel")), "untouched\n")
  })
})

test("next begin consumes a valid stranded quarantine generation", () => {
  withRetentionFixture((fixture) => {
    const name = `.begin-quarantine.${runId(105, "b")}.${"c".repeat(32)}`
    const path = join(fixture.backup, name)
    mkdir(path)
    writeFileSync(join(path, "partial"), "retained\n")

    const result = fixture.invoke()

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(fixture.read(fixture.lease)).generation, 106)
    assert.equal(fixture.read(fixture.counter), "106\n")
    assert.equal(fixture.exists(path), true)
  })
})
