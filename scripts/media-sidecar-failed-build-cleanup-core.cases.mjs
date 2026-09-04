import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { withFixture } from "./media-sidecar-failed-build-cleanup.cases.mjs"

test("failed split builds are cleaned through the fenced owner entrypoint", () => {
  withFixture(({ invoke, removedContainers, removedImages, writeScenario }) => {
    for (const operation of ["build", "build-server", "build-sidecar"]) {
      writeScenario({ operation })
      const result = invoke()
      assert.equal(result.status, 0, `${operation}: ${result.stderr}`)
      const output = JSON.parse(result.stdout)
      assert.equal(output.ok, true)
      assert.equal(output.volumesRemoved, 0)
      const images = readFileSync(removedImages, "utf8")
      const containers = readFileSync(removedContainers, "utf8")
      assert.match(images, new RegExp(`discord-music-server:${"b".repeat(40)}`, "u"))
      assert.match(images, new RegExp(`sha256:${"a".repeat(64)}`, "u"))
      assert.match(images, new RegExp(`sha256:${"c".repeat(64)}`, "u"))
      assert.doesNotMatch(images, new RegExp(`sha256:${"1".repeat(64)}`, "u"))
      assert.doesNotMatch(images, new RegExp(`sha256:${"2".repeat(64)}`, "u"))
      assert.match(containers, new RegExp("b".repeat(64), "u"))
      assert.match(containers, new RegExp("d".repeat(64), "u"))
    }
  })
})

test("failed-build cleanup rejects invalid ownership records before Docker mutation", () => {
  withFixture(({ dockerLog, invoke, lease, writeScenario }) => {
    for (const scenario of [
      { operation: "configure-rust" },
      { operation: "build-server", sequence: "../5" },
      { operation: "build-sidecar", logSequence: null },
      { operation: "build-server", status: "succeeded" },
      { operation: "build-sidecar", state: "active", restoreState: "idle" },
    ]) {
      writeScenario(scenario)
      const beforeLease = readFileSync(lease, "utf8")
      const result = invoke()
      assert.equal(result.status, 1, JSON.stringify(scenario))
      assert.equal(readFileSync(dockerLog, "utf8"), "", JSON.stringify(scenario))
      assert.equal(readFileSync(lease, "utf8"), beforeLease, JSON.stringify(scenario))
    }
    writeScenario({ operation: "build-server" })
    assert.equal(invoke({ callRunId: `8-${"d".repeat(32)}` }).status, 1)
    assert.equal(readFileSync(dockerLog, "utf8"), "")
    writeScenario({ operation: "build-sidecar" })
    assert.equal(invoke({ callSha: "e".repeat(40) }).status, 1)
    assert.equal(readFileSync(dockerLog, "utf8"), "")
  })
})

test("failed-build cleanup refuses to remove a selected image used by any container", () => {
  withFixture(({ invoke, removedImages, writeScenario }) => {
    writeScenario({ operation: "build-server" })
    const result = invoke({ inUseImage: `sha256:${"e".repeat(64)}` })
    assert.equal(result.status, 1)
    assert.equal(result.stderr.trim(), '{"ok":false,"stage":"cleanup-image-in-use"}')
    assert.equal(readFileSync(removedImages, "utf8"), "")
  })
})
