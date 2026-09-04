import assert from "node:assert/strict"
import { join } from "node:path"
import test from "node:test"
import { withRetentionFixture } from "./media-sidecar-retention-test-support.mjs"

const assertNoMutation = (fixture, archives, before) => {
  assert.equal(fixture.read(fixture.dockerMutations), "unchanged\n")
  assert.equal(fixture.read(fixture.lease), before.lease)
  for (const [index, archive] of archives.entries()) {
    assert.equal(fixture.exists(archive.run), true, archive.runId)
    for (const file of ["manifest.json", "terminal.json", "compose.yaml", "deploy.env"])
      assert.equal(fixture.read(join(archive.run, file)), before.archives[index][file])
  }
  assert.equal(fixture.exists(fixture.injectionMarker), false)
}

const snapshot = (fixture, archives) => ({
  lease: fixture.read(fixture.lease),
  archives: archives.map((archive) =>
    Object.fromEntries(
      ["manifest.json", "terminal.json", "compose.yaml", "deploy.env"].map((file) => [
        file,
        fixture.read(join(archive.run, file)),
      ]),
    ),
  ),
})

const corruptions = [
  [
    "duplicate manifest member",
    ({ archive, fixture }) => {
      const path = join(archive.run, "manifest.json")
      fixture.write(path, fixture.read(path).replace("{", '{"schema":"duplicate",'))
    },
  ],
  [
    "wrong manifest type",
    ({ archive, fixture }) => {
      archive.manifest.generation = "2"
      fixture.write(join(archive.run, "manifest.json"), JSON.stringify(archive.manifest))
    },
  ],
  [
    "extra manifest field",
    ({ archive, fixture }) => {
      archive.manifest.untrusted = true
      fixture.write(join(archive.run, "manifest.json"), JSON.stringify(archive.manifest))
    },
  ],
  [
    "cross-bound terminal SHA",
    ({ archive, fixture }) => {
      archive.terminal.selectedSha = "f".repeat(40)
      fixture.write(join(archive.run, "terminal.json"), JSON.stringify(archive.terminal))
    },
  ],
  [
    "forged rollback tag",
    ({ archive, fixture }) => {
      archive.manifest.rollbackTags.server = `bad;touch ${fixture.injectionMarker}`
      fixture.write(join(archive.run, "manifest.json"), JSON.stringify(archive.manifest))
    },
  ],
  [
    "forged prior image ID",
    ({ archive, fixture }) => {
      archive.manifest.priorState.serverImage = `bad;touch ${fixture.injectionMarker}`
      fixture.write(join(archive.run, "manifest.json"), JSON.stringify(archive.manifest))
    },
  ],
  [
    "wrong deployment path",
    ({ archive, fixture }) => {
      archive.manifest.configPath = "/tmp/attacker/compose.yaml"
      fixture.write(join(archive.run, "manifest.json"), JSON.stringify(archive.manifest))
    },
  ],
  [
    "wrong generation binding",
    ({ archive, fixture }) => {
      archive.terminal.generation += 1
      fixture.write(join(archive.run, "terminal.json"), JSON.stringify(archive.terminal))
    },
  ],
  [
    "wrong run binding",
    ({ archive, fixture }) => {
      archive.terminal.runId = `7-${"7".repeat(32)}`
      fixture.write(join(archive.run, "terminal.json"), JSON.stringify(archive.terminal))
    },
  ],
  [
    "nonterminal operation status",
    ({ archive, fixture }) => {
      archive.terminal.sequence = 1
      archive.terminal.acceptedOperations = [
        { sequence: 1, operation: "build", status: "accepted" },
      ]
      fixture.write(join(archive.run, "terminal.json"), JSON.stringify(archive.terminal))
    },
  ],
  [
    "invalid state pair",
    ({ archive, fixture }) => {
      archive.terminal.state = "active"
      fixture.write(join(archive.run, "terminal.json"), JSON.stringify(archive.terminal))
    },
  ],
  [
    "restoring state pair",
    ({ archive, fixture }) => {
      archive.terminal.state = "expired"
      archive.terminal.restoreState = "restoring"
      fixture.write(join(archive.run, "terminal.json"), JSON.stringify(archive.terminal))
    },
  ],
  [
    "forged event proof",
    ({ archive, fixture }) => {
      archive.terminal.stableSamples = 2
      archive.terminal.eventProof = {
        cursor: archive.manifest.eventCursor,
        observedCount: 0,
        quietWindowEvents: 1,
        stableAtBoottime: 90,
      }
      fixture.write(join(archive.run, "terminal.json"), JSON.stringify(archive.terminal))
    },
  ],
]

for (const [index, [name, corrupt]] of corruptions.entries()) {
  test(`retention owner rejects ${name} before every mutation`, () => {
    withRetentionFixture((fixture) => {
      const valid = fixture.addArchive({ generation: 1 })
      const poisoned = fixture.addArchive({
        generation: 2,
        state: index % 2 === 0 ? "expired" : "committed",
      })
      corrupt({ archive: poisoned, fixture })
      const before = snapshot(fixture, [valid, poisoned])
      const result = fixture.invoke()
      assert.equal(result.status, 1, `${name}: ${result.stderr}`)
      assertNoMutation(fixture, [valid, poisoned], before)
    })
  })
}

for (const [name, environment] of [
  ["rollback tag bound to another image", { TAG_MISMATCH: "1" }],
  ["rollback image with wrong revision", { WRONG_REVISION: "1" }],
]) {
  test(`retention owner rejects ${name} before every mutation`, () => {
    withRetentionFixture((fixture) => {
      const first = fixture.addArchive({ generation: 1 })
      const second = fixture.addArchive({ generation: 2, state: "expired" })
      const before = snapshot(fixture, [first, second])
      const result = fixture.invoke(environment)
      assert.equal(result.status, 1, `${name}: ${result.stderr}`)
      assertNoMutation(fixture, [first, second], before)
    })
  })
}

test("retention owner rejects an in-use prior image before every mutation", () => {
  withRetentionFixture((fixture) => {
    const first = fixture.addArchive({ generation: 1 })
    const second = fixture.addArchive({ generation: 2, state: "expired" })
    const before = snapshot(fixture, [first, second])
    const result = fixture.invoke({ IN_USE_IMAGE: second.serverImage })
    assert.equal(result.status, 1, result.stderr)
    assertNoMutation(fixture, [first, second], before)
  })
})

test("retention keeps current, recent, and seven-day-boundary archives", () => {
  withRetentionFixture((fixture) => {
    const expired = fixture.addArchive({ generation: 1 })
    const current = fixture.addArchive({ generation: 2 })
    const recent = fixture.addArchive({ generation: 3, ageMs: 60_000 })
    const boundary = fixture.addArchive({ generation: 4, ageMs: 7 * 86_400_000 - 2_000 })
    fixture.write(fixture.lease, JSON.stringify({ runId: current.runId }))
    const result = fixture.invoke()
    assert.equal(result.status, 0, result.stderr)
    assert.equal(fixture.exists(expired.run), false)
    for (const archive of [current, recent, boundary])
      assert.equal(fixture.exists(archive.run), true)
    assert.doesNotMatch(fixture.read(fixture.dockerMutations), /volume rm/u)
  })
})
