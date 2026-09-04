import { join } from "node:path"
import test from "node:test"
import { withFixture } from "./media-sidecar-failed-build-cleanup.cases.mjs"
import { rewrite } from "./media-sidecar-failed-build-cleanup-hardening.cases.mjs"
import { assertRejectedWithoutMutation } from "./media-sidecar-failed-build-cleanup-json.cases.mjs"

test("cleanup rejects sensitive unknown fields in selected and unselected archives", () => {
  withFixture((fixture) => {
    const injections = [
      [
        "manifest project",
        "manifest.json",
        (record) => {
          record.project = "evil"
        },
      ],
      [
        "manifest revision",
        "manifest.json",
        (record) => {
          record.revision = "9".repeat(40)
        },
      ],
      [
        "manifest image id",
        "manifest.json",
        (record) => {
          record.imageId = `sha256:${"9".repeat(64)}`
        },
      ],
      [
        "prior sensitive field",
        "manifest.json",
        (record) => {
          record.priorState.selectedSha = "9".repeat(40)
        },
      ],
      [
        "rollback sensitive field",
        "manifest.json",
        (record) => {
          record.rollbackTags.revision = "9".repeat(40)
        },
      ],
      [
        "terminal project",
        "terminal.json",
        (record) => {
          record.project = "evil"
        },
      ],
      [
        "terminal revision",
        "terminal.json",
        (record) => {
          record.revision = "9".repeat(40)
        },
      ],
      [
        "operation image id",
        "terminal.json",
        (record) => {
          record.acceptedOperations[0].imageId = `sha256:${"9".repeat(64)}`
        },
      ],
      [
        "active mutation identity",
        "terminal.json",
        (record) => {
          record.activeMutation = { operation: "build", sequence: 5, project: "evil" }
        },
      ],
      [
        "arbitrary secret",
        "terminal.json",
        (record) => {
          record.credentials = "forbidden"
        },
      ],
    ]
    for (const unselected of [false, true]) {
      for (const [label, name, inject] of injections) {
        assertRejectedWithoutMutation(
          fixture,
          ({ historicalRun }) =>
            rewrite(join(historicalRun, name), (record) => {
              if (unselected)
                record.acceptedOperations = [{ operation: "up", sequence: 5, status: "succeeded" }]
              inject(record)
            }),
          `${unselected ? "unselected" : "selected"} ${label}`,
        )
      }
    }
  })
})
