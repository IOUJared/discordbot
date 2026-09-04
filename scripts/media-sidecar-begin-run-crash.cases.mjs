import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { withRetentionFixture } from "./media-sidecar-retention-test-support.mjs"

const pendingNames = (backup) =>
  readdirSync(backup).filter(
    (name) =>
      (name.includes(".tmp") || name.startsWith(".")) && !name.startsWith(".begin-quarantine."),
  )
const quarantineNames = (backup) =>
  readdirSync(backup).filter((name) => name.startsWith(".begin-quarantine."))

for (const phase of [
  "before-counter-fsync",
  "after-counter-fsync",
  "temp-verify",
  "checkpoint-rename",
  "terminal-archive",
  "lease-temp-write",
]) {
  test(`SIGKILL at ${phase} consumes its generation and next begin recovers`, () => {
    withRetentionFixture((fixture) => {
      const priorLease = fixture.read(fixture.lease)
      const terminal = join(fixture.initialCurrent.run, "terminal.json")
      const dockerBefore = fixture.read(fixture.dockerMutations)
      const volumeBefore = fixture.read(fixture.volumeMarker)

      const killed = fixture.invoke(fixture.killAtPhase(phase))

      assert.equal(killed.signal, "SIGKILL")
      assert.equal(fixture.read(fixture.counter), "100\n")
      assert.equal(fixture.read(fixture.lease), priorLease)
      assert.equal(fixture.read(fixture.dockerMutations), dockerBefore)
      assert.equal(fixture.read(fixture.volumeMarker), volumeBefore)
      if (existsSync(terminal)) assert.equal(readFileSync(terminal, "utf8"), priorLease)

      const recovered = fixture.invoke()

      assert.equal(recovered.status, 0, recovered.stderr)
      const lease = JSON.parse(fixture.read(fixture.lease))
      assert.equal(lease.generation, 101)
      assert.match(lease.runId, /^101-[0-9a-f]{32}$/u)
      assert.equal(fixture.read(fixture.counter), "101\n")
      assert.equal(
        readdirSync(fixture.backup).some((name) => name.startsWith("100-")),
        false,
      )
      assert.deepEqual(pendingNames(fixture.backup), [])
      assert.equal(
        quarantineNames(fixture.backup).length,
        phase === "before-counter-fsync" || phase === "after-counter-fsync" ? 0 : 1,
      )
      assert.equal(readFileSync(terminal, "utf8"), priorLease)
      assert.equal(fixture.read(fixture.dockerMutations), dockerBefore)
      assert.equal(fixture.read(fixture.volumeMarker), volumeBefore)
    })
  })
}

test("SIGKILL after active lease rename leaves one complete active checkpoint", () => {
  withRetentionFixture((fixture) => {
    const dockerBefore = fixture.read(fixture.dockerMutations)
    const volumeBefore = fixture.read(fixture.volumeMarker)

    const killed = fixture.invoke(fixture.killAtPhase("active-lease-rename"))

    assert.equal(killed.signal, "SIGKILL")
    const active = JSON.parse(fixture.read(fixture.lease))
    assert.equal(active.generation, 100)
    const checkpoint = join(fixture.backup, active.runId)
    assert.equal(existsSync(join(checkpoint, "manifest.json")), true)
    assert.equal(existsSync(join(checkpoint, ".begin-pending")), true)
    assert.equal(fixture.read(fixture.counter), "100\n")
    assert.equal(fixture.read(fixture.dockerMutations), dockerBefore)
    assert.equal(fixture.read(fixture.volumeMarker), volumeBefore)

    const recovered = fixture.invoke()

    assert.equal(recovered.status, 0, recovered.stderr)
    const next = JSON.parse(fixture.read(fixture.lease))
    assert.equal(next.generation, 101)
    assert.match(next.runId, /^101-[0-9a-f]{32}$/u)
    assert.equal(fixture.read(fixture.counter), "101\n")
    assert.equal(existsSync(checkpoint), false)
    assert.equal(
      readFileSync(join(fixture.initialCurrent.run, "terminal.json"), "utf8"),
      JSON.stringify(fixture.initialCurrent.terminal),
    )
    assert.deepEqual(pendingNames(fixture.backup), [])
    assert.equal(quarantineNames(fixture.backup).length, 1)
    assert.equal(fixture.read(fixture.dockerMutations), dockerBefore)
    assert.equal(fixture.read(fixture.volumeMarker), volumeBefore)
  })
})
