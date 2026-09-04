import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"
import { withFixture } from "./media-sidecar-failed-build-cleanup.cases.mjs"
import { assertRejectedWithoutMutation } from "./media-sidecar-failed-build-cleanup-json.cases.mjs"

export function rewrite(path, update) {
  const value = JSON.parse(readFileSync(path, "utf8"))
  update(value)
  writeFileSync(path, JSON.stringify(value))
}

function replace(path, before, after) {
  writeFileSync(path, readFileSync(path, "utf8").replace(before, after))
}

test("cleanup rejects exponent, fractional, and unsafe archive integers before Docker", () => {
  withFixture((fixture) => {
    const cases = [
      [
        "generation exponent",
        ({ historicalRun }) => {
          for (const name of ["manifest.json", "terminal.json"])
            replace(join(historicalRun, name), '"generation":6', '"generation":1e100')
        },
      ],
      [
        "deadline above safe integer",
        ({ historicalRun }) =>
          replace(
            join(historicalRun, "terminal.json"),
            '"deadlineBoottime":999999',
            '"deadlineBoottime":9007199254740992',
          ),
      ],
      [
        "terminal sequence above safe integer",
        ({ historicalRun }) =>
          replace(
            join(historicalRun, "terminal.json"),
            '"sequence":5',
            '"sequence":9007199254740992',
          ),
      ],
      [
        "stable samples fraction",
        ({ historicalRun }) =>
          replace(join(historicalRun, "terminal.json"), '"stableSamples":2', '"stableSamples":1.5'),
      ],
      [
        "reconcile exponent",
        ({ historicalRun }) =>
          replace(
            join(historicalRun, "terminal.json"),
            '"reconcilePasses":0',
            '"reconcilePasses":1e3',
          ),
      ],
      [
        "operation sequence exponent",
        ({ historicalRun }) =>
          replace(
            join(historicalRun, "terminal.json"),
            '"operation":"build-sidecar","sequence":5',
            '"operation":"build-sidecar","sequence":1e100',
          ),
      ],
      [
        "event count above safe integer",
        ({ historicalRun }) =>
          replace(
            join(historicalRun, "terminal.json"),
            '"observedCount":4',
            '"observedCount":9007199254740992',
          ),
      ],
      [
        "event stable time exponent",
        ({ historicalRun }) =>
          replace(
            join(historicalRun, "terminal.json"),
            '"stableAtBoottime":99',
            '"stableAtBoottime":1e100',
          ),
      ],
    ]
    for (const [label, mutate] of cases) assertRejectedWithoutMutation(fixture, mutate, label)
  })
})

test("cleanup accepts the maximum safe integer without jq rounding", () => {
  withFixture(({ historicalRun, invoke, writeScenario }) => {
    writeScenario({ operation: "build-sidecar" })
    replace(
      join(historicalRun, "terminal.json"),
      '"deadlineBoottime":999999',
      '"deadlineBoottime":9007199254740991',
    )
    const result = invoke()
    assert.equal(result.status, 0, result.stderr)
  })
})

test("cleanup accepts the exact legacy committed proof and cleanup representation", () => {
  withFixture(({ historicalRun, invoke, writeScenario }) => {
    writeScenario({ operation: "build-sidecar" })
    rewrite(join(historicalRun, "terminal.json"), (terminal) => {
      terminal.state = "committed"
      terminal.restoreState = "idle"
      terminal.stableSamples = 0
      terminal.eventProof = null
      terminal.cleanup = null
    })
    const result = invoke()
    assert.equal(result.status, 0, result.stderr)
  })
})

test("cleanup requires the exact terminal event proof schema", () => {
  withFixture((fixture) => {
    const cases = [
      [
        "empty proof",
        (_proof, terminal) => {
          terminal.eventProof = {}
        },
      ],
      [
        "missing proof count",
        (proof) => {
          delete proof.observedCount
        },
      ],
      [
        "null proof count",
        (proof) => {
          proof.observedCount = null
        },
      ],
      [
        "wrong proof cursor",
        (proof) => {
          proof.cursor = "2026-09-04T00:00:01Z"
        },
      ],
      [
        "nonzero quiet events",
        (proof) => {
          proof.quietWindowEvents = 1
        },
      ],
      [
        "unknown proof field",
        (proof) => {
          proof.revision = "9".repeat(40)
        },
      ],
    ]
    for (const [label, mutate] of cases) {
      assertRejectedWithoutMutation(
        fixture,
        ({ historicalRun }) =>
          rewrite(join(historicalRun, "terminal.json"), (terminal) =>
            mutate(terminal.eventProof, terminal),
          ),
        label,
      )
    }
  })
})
