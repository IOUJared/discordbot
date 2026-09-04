import assert from "node:assert/strict"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { withRetentionFixture } from "./media-sidecar-retention-test-support.mjs"

const makeDirectory = (path) => {
  mkdirSync(path, { mode: 0o700 })
  chmodSync(path, 0o700)
}
const baseline = (fixture) => ({
  counter: fixture.read(fixture.counter),
  docker: fixture.read(fixture.dockerMutations),
  lease: fixture.read(fixture.lease),
  volume: fixture.read(fixture.volumeMarker),
})
const assertUnchanged = (fixture, before) => {
  assert.equal(fixture.read(fixture.counter), before.counter)
  assert.equal(fixture.read(fixture.dockerMutations), before.docker)
  assert.equal(fixture.read(fixture.lease), before.lease)
  assert.equal(fixture.read(fixture.volumeMarker), before.volume)
}

for (const shape of ["temp", "quarantine"]) {
  test(`nested bind mount in ${shape} fails closed before recovery mutation`, () => {
    withRetentionFixture((fixture) => {
      const runId = `100-${"a".repeat(32)}`
      const name =
        shape === "temp" ? `.${runId}.tmp` : `.begin-quarantine.${runId}.${"b".repeat(32)}`
      const artifact = join(fixture.backup, name)
      const target = join(artifact, "mounted")
      const source = join(dirname(fixture.backup), `mount-source-${shape}`)
      makeDirectory(artifact)
      makeDirectory(target)
      makeDirectory(source)
      writeFileSync(join(source, "sentinel"), "mounted\n")
      const before = baseline(fixture)

      const result = fixture.invokeWithBindMount(source, target)

      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /begin-recovery-failed/u)
      assertUnchanged(fixture, before)
      assert.equal(fixture.exists(artifact), true)
      assert.equal(fixture.read(join(source, "sentinel")), "mounted\n")
    })
  })
}
