import assert from "node:assert/strict"
import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { withFixture } from "./media-sidecar-failed-build-cleanup.cases.mjs"

const selectedSha = "b".repeat(40)
const otherSha = "9".repeat(40)

function fileSnapshot(lease, run, historicalRun) {
  const files = [
    lease,
    join(run, "manifest.json"),
    ...readdirSync(join(run, "operations")).map((name) => join(run, "operations", name)),
    join(historicalRun, "manifest.json"),
    join(historicalRun, "terminal.json"),
    ...readdirSync(join(historicalRun, "operations")).map((name) =>
      join(historicalRun, "operations", name),
    ),
    join(run, "compose-state"),
    join(run, "volume-state"),
  ]
  return files.map((path) => [path, readFileSync(path, "utf8")])
}

function insertBeforeEnd(path, members) {
  const source = readFileSync(path, "utf8")
  writeFileSync(path, `${source.slice(0, -1)},${members}}`)
}

export function assertRejectedWithoutMutation(fixture, mutate, label) {
  const {
    dockerLog,
    historicalRun,
    invoke,
    lease,
    removedContainers,
    removedImages,
    run,
    writeScenario,
  } = fixture
  writeScenario({ operation: "build-sidecar" })
  writeFileSync(join(run, "compose-state"), "running")
  writeFileSync(join(run, "volume-state"), "deploy_discord-music-data")
  mutate({ historicalRun, lease, run })
  const before = fileSnapshot(lease, run, historicalRun)
  const result = invoke()
  assert.equal(result.status, 1, `${label}: ${result.stderr}`)
  assert.deepEqual(fileSnapshot(lease, run, historicalRun), before, label)
  assert.equal(readFileSync(removedImages, "utf8"), "", label)
  assert.equal(readFileSync(removedContainers, "utf8"), "", label)
  assert.equal(readFileSync(dockerLog, "utf8"), "", label)
}

test("cleanup rejects identical and conflicting duplicate identity keys before Docker", () => {
  withFixture((fixture) => {
    const cases = [
      [
        "manifest conflicting selectedSha",
        ({ run }) => insertBeforeEnd(join(run, "manifest.json"), `"selectedSha":"${selectedSha}"`),
      ],
      [
        "manifest identical selectedSha",
        ({ run }) => insertBeforeEnd(join(run, "manifest.json"), `"selectedSha":"${selectedSha}"`),
      ],
      [
        "lease conflicting selectedSha",
        ({ lease }) => insertBeforeEnd(lease, `"selectedSha":"${selectedSha}"`),
      ],
      [
        "lease identical selectedSha",
        ({ lease }) => insertBeforeEnd(lease, `"selectedSha":"${selectedSha}"`),
      ],
    ]
    for (const [label, mutate] of cases) {
      assertRejectedWithoutMutation(
        fixture,
        ({ lease, run, ...paths }) => {
          if (label.includes("conflicting")) {
            const path = label.startsWith("lease") ? lease : join(run, "manifest.json")
            writeFileSync(path, readFileSync(path, "utf8").replace(selectedSha, otherSha))
          }
          mutate({ lease, run, ...paths })
        },
        label,
      )
    }
  })
})

test("cleanup rejects duplicate binding and nested operation fields in every JSON record", () => {
  withFixture((fixture) => {
    const cases = [
      [
        "manifest schema",
        ({ run }) =>
          insertBeforeEnd(
            join(run, "manifest.json"),
            '"schema":"wrong","schema":"discord-music-deploy-lease.v1"',
          ),
      ],
      [
        "manifest runId",
        ({ run }) => insertBeforeEnd(join(run, "manifest.json"), `"runId":"7-${"a".repeat(32)}"`),
      ],
      [
        "manifest project",
        ({ run }) =>
          insertBeforeEnd(join(run, "manifest.json"), '"project":"wrong","project":"deploy"'),
      ],
      [
        "manifest revision",
        ({ run }) =>
          insertBeforeEnd(
            join(run, "manifest.json"),
            `"revision":"${otherSha}","revision":"${selectedSha}"`,
          ),
      ],
      [
        "manifest nested prior image",
        ({ run }) => {
          const manifest = join(run, "manifest.json")
          writeFileSync(
            manifest,
            readFileSync(manifest, "utf8").replace(
              '"serverImage":"sha256:',
              '"serverImage":"sha256:0000","serverImage":"sha256:',
            ),
          )
        },
      ],
      [
        "manifest nested prior sidecar image",
        ({ run }) => {
          const manifest = join(run, "manifest.json")
          writeFileSync(
            manifest,
            readFileSync(manifest, "utf8").replace(
              '"sidecarImage":"sha256:',
              '"sidecarImage":"sha256:0000","sidecarImage":"sha256:',
            ),
          )
        },
      ],
      [
        "lease schema",
        ({ lease }) =>
          insertBeforeEnd(lease, '"schema":"wrong","schema":"discord-music-deploy-lease.v1"'),
      ],
      ["lease runId", ({ lease }) => insertBeforeEnd(lease, `"runId":"7-${"a".repeat(32)}"`)],
      ["lease state", ({ lease }) => insertBeforeEnd(lease, '"state":"active","state":"expired"')],
      [
        "lease restore state",
        ({ lease }) =>
          insertBeforeEnd(lease, '"restoreState":"restoring","restoreState":"restored"'),
      ],
      [
        "lease operation",
        ({ lease }) =>
          writeFileSync(
            lease,
            readFileSync(lease, "utf8").replace(
              '"operation":"build-sidecar"',
              '"operation":"build","operation":"build-sidecar"',
            ),
          ),
      ],
      [
        "lease operation status",
        ({ lease }) =>
          writeFileSync(
            lease,
            readFileSync(lease, "utf8").replace(
              '"status":"failed"',
              '"status":"succeeded","status":"failed"',
            ),
          ),
      ],
      [
        "archived operation sequence",
        ({ historicalRun }) => {
          const terminal = join(historicalRun, "terminal.json")
          writeFileSync(
            terminal,
            readFileSync(terminal, "utf8").replace('"sequence":5', '"sequence":4,"sequence":5'),
          )
        },
      ],
    ]
    for (const [label, mutate] of cases) assertRejectedWithoutMutation(fixture, mutate, label)
  })
})

test("cleanup rejects empty, malformed, and multiple JSON documents before Docker", () => {
  withFixture((fixture) => {
    for (const location of ["manifest", "lease", "archived manifest", "archived operation"]) {
      for (const [kind, content] of [
        ["empty", ""],
        ["malformed", "{"],
        ["multiple", '{}\n{"selectedSha":"ignored"}'],
      ]) {
        assertRejectedWithoutMutation(
          fixture,
          ({ historicalRun, lease, run }) => {
            const path =
              location === "lease"
                ? lease
                : location === "manifest"
                  ? join(run, "manifest.json")
                  : join(
                      historicalRun,
                      location === "archived manifest" ? "manifest.json" : "terminal.json",
                    )
            writeFileSync(path, content)
          },
          `${location} ${kind}`,
        )
      }
    }
  })
})
