import assert from "node:assert/strict"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { withFixture } from "./media-sidecar-failed-build-cleanup.cases.mjs"

const selectedSha = "b".repeat(40)

const bytes = (lease, run) =>
  JSON.stringify({
    lease: readFileSync(lease, "utf8"),
    manifest: readFileSync(join(run, "manifest.json"), "utf8"),
    operations: readdirSync(join(run, "operations")).map((name) => [
      name,
      readFileSync(join(run, "operations", name), "utf8"),
    ]),
  })

test("all selected images are proven unused before the first removal", () => {
  withFixture(({ invoke, lease, removedContainers, removedImages, run, writeScenario }) => {
    for (const operation of ["build", "build-server", "build-sidecar"]) {
      writeScenario({ operation })
      const before = bytes(lease, run)
      const result = invoke({ inUseImage: `sha256:${"f".repeat(64)}` })
      assert.equal(result.status, 1, operation)
      assert.equal(result.stderr.trim(), '{"ok":false,"stage":"cleanup-image-in-use"}')
      assert.equal(readFileSync(removedImages, "utf8"), "", operation)
      assert.equal(readFileSync(removedContainers, "utf8"), "", operation)
      assert.equal(bytes(lease, run), before, operation)
    }
  })
})

test("manifest, project, and image revision bindings reject before mutation", () => {
  withFixture(
    ({ dockerLog, invoke, lease, removedContainers, removedImages, run, writeScenario }) => {
      const composeState = join(run, "compose-state")
      const volumeState = join(run, "volume-state")
      writeFileSync(composeState, "running")
      writeFileSync(volumeState, "deploy_discord-music-data")
      for (const scenario of [
        { manifestCase: "wrong-schema" },
        { manifestCase: "missing-schema" },
        { manifestCase: "wrong-run" },
        { manifestCase: "missing-run" },
        { manifestCase: "wrong-sha" },
        { manifestCase: "missing-sha" },
        { manifestCase: "malformed" },
        { project: "other" },
        { serverRevision: "e".repeat(40) },
        { sidecarRevision: "e".repeat(40) },
      ]) {
        writeScenario({ operation: "build-sidecar", manifestCase: scenario.manifestCase })
        const before = bytes(lease, run)
        const result = invoke(scenario)
        assert.equal(result.status, 1, JSON.stringify(scenario))
        assert.equal(readFileSync(removedImages, "utf8"), "", JSON.stringify(scenario))
        assert.equal(readFileSync(removedContainers, "utf8"), "", JSON.stringify(scenario))
        assert.equal(bytes(lease, run), before, JSON.stringify(scenario))
        assert.equal(readFileSync(composeState, "utf8"), "running")
        assert.equal(readFileSync(volumeState, "utf8"), "deploy_discord-music-data")
        assert.doesNotMatch(
          readFileSync(dockerLog, "utf8"),
          /\b(?:compose|volume|prune)\b|\b(?:image|container) rm\b/u,
        )
      }
    },
  )
})

test("lease schema and identity bindings reject before mutation", () => {
  withFixture(
    ({ dockerLog, invoke, lease, removedContainers, removedImages, run, writeScenario }) => {
      for (const field of ["schema", "runId", "selectedSha"]) {
        writeScenario({ operation: "build-sidecar" })
        const value = JSON.parse(readFileSync(lease, "utf8"))
        delete value[field]
        writeFileSync(lease, JSON.stringify(value))
        const before = bytes(lease, run)
        assert.equal(invoke().status, 1, field)
        assert.equal(bytes(lease, run), before, field)
        assert.equal(readFileSync(removedImages, "utf8"), "", field)
        assert.equal(readFileSync(removedContainers, "utf8"), "", field)
        assert.doesNotMatch(readFileSync(dockerLog, "utf8"), /\b(?:image|container) rm\b/u)
      }
    },
  )
})

test("valid combined cleanup removes every planned candidate only after validation", () => {
  withFixture(({ invoke, removedContainers, removedImages, writeScenario }) => {
    writeScenario({ operation: "build" })
    const result = invoke()
    assert.equal(result.status, 0, result.stderr)
    assert.match(readFileSync(removedImages, "utf8"), new RegExp(selectedSha, "u"))
    assert.notEqual(readFileSync(removedContainers, "utf8"), "")
  })
})
