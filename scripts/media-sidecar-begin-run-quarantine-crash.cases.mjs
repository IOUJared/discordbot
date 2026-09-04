import assert from "node:assert/strict"
import { chmodSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { withRetentionFixture } from "./media-sidecar-retention-test-support.mjs"

const suffix = "a".repeat(32)
const runId = `100-${suffix}`
const tempName = `.${runId}.tmp`
const quarantineNames = (fixture) =>
  readdirSync(fixture.backup).filter((name) => name.startsWith(".begin-quarantine."))
const counterStages = (fixture) =>
  readdirSync(fixture.backup).filter((name) => name.startsWith("run-counter.recover."))
const makeTemp = (fixture) => {
  const path = join(fixture.backup, tempName)
  mkdirSync(path, { mode: 0o700 })
  chmodSync(path, 0o700)
  return path
}

for (const [phase, sourcePresent, quarantineCount, counter, stageCount] of [
  ["recovery-before-quarantine-rename", true, 0, "99\n", 0],
  ["recovery-after-quarantine-rename", false, 1, "99\n", 0],
  ["recovery-after-quarantine-fsync", false, 1, "99\n", 0],
  ["recovery-before-counter-temp", false, 1, "99\n", 0],
  ["recovery-before-counter-rename", false, 1, "99\n", 1],
  ["recovery-after-counter-rename", false, 1, "100\n", 0],
  ["recovery-after-counter-fsync", false, 1, "100\n", 0],
  ["recovery-cleanup", false, 0, "100\n", 0],
]) {
  test(`SIGKILL at ${phase} leaves a recoverable transaction`, () => {
    withRetentionFixture((fixture) => {
      const temp = makeTemp(fixture)
      const priorLease = fixture.read(fixture.lease)
      const terminal = join(fixture.initialCurrent.run, "terminal.json")
      const priorTerminal = fixture.exists(terminal) ? fixture.read(terminal) : null
      const docker = fixture.read(fixture.dockerMutations)
      const volume = fixture.read(fixture.volumeMarker)

      const killed = fixture.invoke(fixture.killAtPhase(phase))

      assert.equal(killed.signal, "SIGKILL")
      assert.equal(fixture.exists(temp), sourcePresent)
      assert.equal(quarantineNames(fixture).length, quarantineCount)
      assert.equal(counterStages(fixture).length, stageCount)
      assert.equal(fixture.read(fixture.counter), counter)
      assert.equal(fixture.read(fixture.lease), priorLease)
      assert.equal(fixture.read(fixture.dockerMutations), docker)
      assert.equal(fixture.read(fixture.volumeMarker), volume)
      if (priorTerminal !== null && fixture.exists(terminal))
        assert.equal(fixture.read(terminal), priorTerminal)

      const recovered = fixture.invoke()
      assert.equal(recovered.status, 0, recovered.stderr)
      assert.equal(JSON.parse(fixture.read(fixture.lease)).generation, 101)
      assert.equal(fixture.read(fixture.counter), "101\n")
      assert.equal(fixture.exists(temp), false)
      assert.deepEqual(counterStages(fixture), [])
      assert.deepEqual(quarantineNames(fixture), [])
      assert.equal(fixture.read(fixture.dockerMutations), docker)
      assert.equal(fixture.read(fixture.volumeMarker), volume)
      assert.equal(fixture.read(terminal), priorLease)
    })
  })
}

test("forced quarantine target collision preserves both artifacts", () => {
  withRetentionFixture((fixture) => {
    const temp = makeTemp(fixture)
    writeFileSync(join(temp, "new"), "new\n")
    const occupiedName = `.begin-quarantine.${runId}.${"b".repeat(32)}`
    const occupied = join(fixture.backup, occupiedName)
    mkdirSync(occupied, { mode: 0o700 })
    chmodSync(occupied, 0o700)
    writeFileSync(join(occupied, "sentinel"), "existing\n")

    const result = fixture.invoke({
      MEDIA_OWNER_TEST_QUARANTINE_TOKENS: `${"b".repeat(32)},${"c".repeat(32)}`,
    })

    assert.equal(result.status, 0, result.stderr)
    assert.equal(fixture.read(join(occupied, "sentinel")), "existing\n")
    assert.equal(
      fixture.exists(join(fixture.backup, `.begin-quarantine.${runId}.${"c".repeat(32)}`)),
      true,
    )
    assert.equal(JSON.parse(fixture.read(fixture.lease)).generation, 101)
  })
})

test("mixed temp final and quarantine generations allocate above the maximum", () => {
  withRetentionFixture((fixture) => {
    const temp = makeTemp(fixture)
    writeFileSync(join(temp, "partial"), "temp\n")
    const finalId = `105-${"d".repeat(32)}`
    const final = join(fixture.backup, finalId)
    mkdirSync(final, { mode: 0o700 })
    chmodSync(final, 0o700)
    writeFileSync(
      join(final, ".begin-pending"),
      JSON.stringify({
        schema: "discord-music-begin-pending.v1",
        runId: finalId,
        generation: 105,
        priorRunId: fixture.initialCurrent.runId,
      }),
    )
    chmodSync(join(final, ".begin-pending"), 0o600)
    const quarantine = join(
      fixture.backup,
      `.begin-quarantine.110-${"e".repeat(32)}.${"f".repeat(32)}`,
    )
    mkdirSync(quarantine, { mode: 0o700 })
    chmodSync(quarantine, 0o700)
    writeFileSync(join(quarantine, "partial"), "quarantine\n")

    const result = fixture.invoke()

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(fixture.read(fixture.lease)).generation, 111)
    assert.equal(fixture.read(fixture.counter), "111\n")
    assert.equal(fixture.exists(temp), false)
    assert.equal(fixture.exists(final), false)
    assert.equal(fixture.exists(quarantine), true)
  })
})

test("two concurrent begin owners serialize and consume one generation", () => {
  withRetentionFixture((fixture) => {
    const docker = fixture.read(fixture.dockerMutations)
    const volume = fixture.read(fixture.volumeMarker)
    const result = fixture.invokeConcurrent({ MEDIA_OWNER_TEST_HOLD_LOCK_MS: "150" })

    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(result.statuses.toSorted(), [0, 1])
    assert.equal(result.errors.filter((value) => /active-run-exists/u.test(value)).length, 1)
    assert.equal(result.outputs.filter((value) => /"ok":true/u.test(value)).length, 1)
    assert.equal(JSON.parse(fixture.read(fixture.lease)).generation, 100)
    assert.equal(fixture.read(fixture.counter), "100\n")
    assert.equal(
      readdirSync(fixture.backup).filter((name) => /^100-[0-9a-f]{32}$/u.test(name)).length,
      1,
    )
    assert.equal(quarantineNames(fixture).length, 0)
    assert.equal(fixture.read(fixture.dockerMutations), docker)
    assert.equal(fixture.read(fixture.volumeMarker), volume)
  })
})
