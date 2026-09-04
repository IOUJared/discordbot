import assert from "node:assert/strict"
import { chmodSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import test from "node:test"
import { withRetentionFixture } from "./media-sidecar-retention-test-support.mjs"

const suffix = "a".repeat(32)
const tempName = `.100-${suffix}.tmp`
const finalName = `100-${suffix}`

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
  assert.equal(
    readdirSync(fixture.backup).some((name) => name.startsWith("101-")),
    false,
  )
}

const makeDirectory = (path, mode = 0o700) => {
  mkdirSync(path, { mode })
  chmodSync(path, mode)
}

test("unmarked regular temp is removed and its generation is never reused", () => {
  withRetentionFixture((fixture) => {
    const temp = join(fixture.backup, tempName)
    makeDirectory(temp)
    writeFileSync(join(temp, "partial"), "incomplete\n")

    const result = fixture.invoke()

    assert.equal(result.status, 0, result.stderr)
    const lease = JSON.parse(fixture.read(fixture.lease))
    assert.equal(lease.generation, 101)
    assert.equal(fixture.read(fixture.counter), "101\n")
    assert.equal(fixture.exists(temp), false)
  })
})

for (const [shape, variant, name, create, environment] of [
  ["temp", "file", tempName, (path) => writeFileSync(path, "not a directory\n")],
  ["temp", "wrong-mode", tempName, (path) => makeDirectory(path, 0o755)],
  [
    "temp",
    "wrong-owner",
    tempName,
    (path) => makeDirectory(path),
    (path) => ({ WRONG_ARTIFACT_OWNER_PATH: path }),
  ],
  ["final", "file", finalName, (path) => writeFileSync(path, "not a directory\n")],
  ["final", "wrong-mode", finalName, (path) => makeDirectory(path, 0o755)],
  [
    "final",
    "wrong-owner",
    finalName,
    (path) => makeDirectory(path),
    (path) => ({ WRONG_ARTIFACT_OWNER_PATH: path }),
  ],
  ["final", "unmarked-incomplete", finalName, (path) => makeDirectory(path)],
]) {
  test(`ambiguous ${shape} ${variant} fails before mutation`, () => {
    withRetentionFixture((fixture) => {
      const artifact = join(fixture.backup, name)
      create(artifact)
      const before = baseline(fixture)

      const result = fixture.invoke(environment?.(artifact))

      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /begin-recovery-artifact-invalid|begin-recovery-archive-invalid/u)
      assertUnchanged(fixture, before)
      assert.equal(fixture.exists(artifact), true)
    })
  })
}

for (const [shape, name] of [
  ["temp", tempName],
  ["final", finalName],
]) {
  test(`${shape} symlink fails closed without touching its target`, () => {
    withRetentionFixture((fixture) => {
      const target = join(dirname(fixture.backup), `outside-${shape}`)
      makeDirectory(target)
      writeFileSync(join(target, "sentinel"), "untouched\n")
      symlinkSync(target, join(fixture.backup, name))
      const before = baseline(fixture)

      const result = fixture.invoke()

      assert.equal(result.status, 1, result.stderr)
      assert.match(result.stderr, /begin-recovery-artifact-invalid/u)
      assertUnchanged(fixture, before)
      assert.equal(fixture.read(join(target, "sentinel")), "untouched\n")
    })
  })
}

test("corrupt pending marker fails before counter or Docker mutation", () => {
  withRetentionFixture((fixture) => {
    const temp = join(fixture.backup, tempName)
    makeDirectory(temp)
    writeFileSync(join(temp, ".begin-pending"), "{")
    chmodSync(join(temp, ".begin-pending"), 0o600)
    const before = baseline(fixture)

    const result = fixture.invoke()

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /begin-recovery-failed/u)
    assertUnchanged(fixture, before)
  })
})

test("corrupt marker on a final checkpoint fails before mutation", () => {
  withRetentionFixture((fixture) => {
    const checkpoint = join(fixture.backup, finalName)
    makeDirectory(checkpoint)
    writeFileSync(join(checkpoint, ".begin-pending"), "{")
    chmodSync(join(checkpoint, ".begin-pending"), 0o600)
    const before = baseline(fixture)

    const result = fixture.invoke()

    assert.equal(result.status, 1, result.stderr)
    assert.match(result.stderr, /begin-recovery-failed/u)
    assertUnchanged(fixture, before)
  })
})

for (const [name, counter, expected] of [
  ["behind", "50\n", 101],
  ["ahead", "150\n", 151],
]) {
  test(`recovery keeps a ${name} counter monotonic across observed artifacts`, () => {
    withRetentionFixture((fixture) => {
      fixture.write(fixture.counter, counter)
      const temp = join(fixture.backup, tempName)
      makeDirectory(temp)

      const result = fixture.invoke()

      assert.equal(result.status, 0, result.stderr)
      const lease = JSON.parse(fixture.read(fixture.lease))
      assert.equal(lease.generation, expected)
      assert.equal(fixture.read(fixture.counter), `${expected}\n`)
      assert.equal(fixture.exists(temp), false)
    })
  })
}

test("canonical unmarked final archive is preserved and advances the counter", () => {
  withRetentionFixture((fixture) => {
    const archive = fixture.addArchive({ generation: 100, ageMs: 60_000 })

    const result = fixture.invoke()

    assert.equal(result.status, 0, result.stderr)
    assert.equal(JSON.parse(fixture.read(fixture.lease)).generation, 101)
    assert.equal(fixture.exists(archive.run), true)
  })
})
