import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { withFixture } from "./media-sidecar-failed-build-cleanup.cases.mjs"
import { assertRejectedWithoutMutation } from "./media-sidecar-failed-build-cleanup-json.cases.mjs"

function rewrite(path, update) {
  const value = JSON.parse(readFileSync(path, "utf8"))
  update(value)
  writeFileSync(path, JSON.stringify(value))
}

function fieldCases(record, field, invalidValues = [null, false]) {
  return [
    ...invalidValues.map((value) => [
      `${record} ${field}=${JSON.stringify(value)}`,
      (json) => {
        json[field] = value
      },
    ]),
    [
      `${record} missing ${field}`,
      (json) => {
        delete json[field]
      },
    ],
  ]
}

test("cleanup rejects wrong-typed and missing archived manifest bindings before Docker", () => {
  withFixture((fixture) => {
    const cases = [
      ...fieldCases("manifest", "schema", [null, false, "wrong"]),
      ...fieldCases("manifest", "runId", [null, false, `9-${"d".repeat(32)}`]),
      ...fieldCases("manifest", "generation", [null, false, "6", 0, 1.5]),
      ...fieldCases("manifest", "selectedSha", [null, false, "9".repeat(40)]),
      ...fieldCases("manifest", "eventCursor", [null, false, "not-a-timestamp"]),
      [
        "manifest prior server image=null",
        (json) => {
          json.priorState.serverImage = null
        },
      ],
      [
        "manifest prior sidecar image malformed",
        (json) => {
          json.priorState.sidecarImage = "sha256:short"
        },
      ],
      [
        "manifest hash wrong type",
        (json) => {
          json.composeHash = false
        },
      ],
    ]
    for (const [label, mutate] of cases) {
      assertRejectedWithoutMutation(
        fixture,
        ({ historicalRun }) => rewrite(join(historicalRun, "manifest.json"), mutate),
        label,
      )
    }
  })
})

test("cleanup rejects wrong-typed, missing, and invalid archived terminal fields", () => {
  withFixture((fixture) => {
    const directCases = [
      ...fieldCases("terminal", "schema", [null, false, "wrong"]),
      ...fieldCases("terminal", "runId", [null, false, `9-${"d".repeat(32)}`]),
      ...fieldCases("terminal", "selectedSha", [null, false, "9".repeat(40)]),
      ...fieldCases("terminal", "state", [null, false, "active", "unknown"]),
      ...fieldCases("terminal", "restoreState", [null, false, "restoring", "unknown"]),
      ...fieldCases("terminal", "sequence", [null, false, "5", 0, 1.5]),
      ...fieldCases("terminal", "acceptedOperations", [null, false, {}]),
    ]
    const operationCases = [
      ...fieldCases("operation", "operation", [null, false, "unknown"]),
      ...fieldCases("operation", "status", [null, false, "accepted", "unknown"]),
      ...fieldCases("operation", "sequence", [null, false, "5", 0, 1.5]),
    ]
    for (const [label, mutate] of directCases) {
      assertRejectedWithoutMutation(
        fixture,
        ({ historicalRun }) => rewrite(join(historicalRun, "terminal.json"), mutate),
        label,
      )
    }
    for (const [label, mutate] of operationCases) {
      assertRejectedWithoutMutation(
        fixture,
        ({ historicalRun }) => {
          const terminal = join(historicalRun, "terminal.json")
          rewrite(terminal, (json) => {
            mutate(json.acceptedOperations[0])
          })
        },
        label,
      )
    }
  })
})

test("cleanup rejects a malformed archived record even when no operation is selected from it", () => {
  withFixture((fixture) => {
    assertRejectedWithoutMutation(
      fixture,
      ({ historicalRun }) => {
        rewrite(join(historicalRun, "terminal.json"), (terminal) => {
          terminal.acceptedOperations = [{ operation: "up", sequence: 5, status: "succeeded" }]
          terminal.state = false
        })
      },
      "unselected archived terminal",
    )
  })
})

test("cleanup accepts canonical archived records for every owner operation", () => {
  withFixture(({ historicalRun, invoke, writeScenario }) => {
    for (const operation of [
      "tag-prior",
      "receive-bundle",
      "checkout",
      "build",
      "build-server",
      "build-sidecar",
      "configure-shadow",
      "configure-rust",
      "configure-disabled",
      "up",
      "stop-sidecar",
      "start-sidecar",
      "benchmark-live",
      "benchmark-fallback",
      "benchmark-disabled",
      "benchmark-fresh",
      "drill-accept",
    ]) {
      writeScenario({ operation: "build-sidecar" })
      rewrite(join(historicalRun, "terminal.json"), (terminal) => {
        terminal.acceptedOperations = [{ operation, sequence: 5, status: "succeeded" }]
      })
      const result = invoke()
      assert.equal(result.status, 0, `${operation}: ${result.stderr}`)
    }
  })
})
