import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { attestCodeQualityFixture } from "./media-sidecar-quality-attestation.mjs"
import { REQUIRED_BOUNDARIES, SOURCE_PATHS } from "./media-sidecar-quality-boundaries.mjs"

const command = fileURLToPath(new URL("./media-sidecar-integration.mjs", import.meta.url))
const requirements = REQUIRED_BOUNDARIES

function fixture(state = {}) {
  const directory = mkdtempSync(join(tmpdir(), "media-attestation-"))
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
  const statePath = join(directory, "state.json")
  writeFileSync(
    statePath,
    JSON.stringify({
      ok: true,
      kind: "final-production-qa",
      sha,
      mode: "rust",
      sidecarHealthy: true,
      internalState: "ready",
      terminal: "committed",
      publicHealthKeys: ["discord", "status", "uptime", "voice"],
      uncached: {
        node: 40,
        rust: 40,
        upstream: 40,
        inMemoryIdMatch: 40,
        local: 0,
        fallback: 0,
        p95Ms: 700,
      },
      replay: { node: 40, rust: 0, upstream: 0, local: 0, fallback: 0, p95Ms: 0.5 },
      fallback: { local: 1, fallback: 1 },
      disabled: { rust: 0, local: 1 },
      fresh: { durationMs: 500, state: "ready" },
      resolve: { observed: true, success: true },
      stableSamples: 2,
      dbVolumesPreserved: true,
      leaseSequence: 15,
      eventProof: { retained: true, quietWindowEvents: 0 },
      ...state,
    }),
  )
  return { directory, sha, statePath, output: join(directory, "report.md") }
}

function attest(item, extra = []) {
  return spawnSync(
    process.execPath,
    [
      command,
      "attest-code-quality",
      "--bind-sha",
      item.sha,
      "--post-f3-evidence",
      item.statePath,
      "--output",
      item.output,
      ...extra,
      "--assert",
    ],
    { encoding: "utf8" },
  )
}

function sourceFixture(item) {
  const sourceRoot = join(item.directory, "source")
  for (const sourcePath of SOURCE_PATHS) {
    const target = join(sourceRoot, sourcePath)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(process.cwd(), sourcePath), target)
  }
  return sourceRoot
}

function fixtureValues(item) {
  return new Map([
    ["bind-sha", item.sha],
    ["post-f3-evidence", item.statePath],
    ["output", item.output],
    ...requirements.map((name) => [`require-${name}`, true]),
  ])
}

for (const omitted of requirements) {
  test(`code-quality attestation requires ${omitted}`, () => {
    const item = fixture()
    try {
      const flags = requirements
        .filter((name) => name !== omitted)
        .flatMap((name) => [`--require-${name}`])
      const result = attest(item, flags)
      assert.equal(result.status, 1)
      assert.match(result.stderr, new RegExp(`attestation-require-${omitted}`, "u"))
    } finally {
      rmSync(item.directory, { recursive: true, force: true })
    }
  })
}

test("code-quality attestation approves complete SHA-bound evidence", () => {
  const item = fixture()
  try {
    const sourceRoot = sourceFixture(item)
    attestCodeQualityFixture(fixtureValues(item), item.sha, sourceRoot)
    assert.match(readFileSync(item.output, "utf8"), /APPROVE/u)
  } finally {
    rmSync(item.directory, { recursive: true, force: true })
  }
})

test("code-quality attestation rejects a missing source proof", () => {
  const item = fixture()
  const sourceRoot = join(item.directory, "empty-source")
  try {
    assert.throws(
      () => attestCodeQualityFixture(fixtureValues(item), item.sha, sourceRoot),
      /attestation-proof/u,
    )
  } finally {
    rmSync(item.directory, { recursive: true, force: true })
  }
})

test("code-quality attestation rejects incomplete F3 state", () => {
  const item = fixture({ sidecarHealthy: false })
  try {
    const result = attest(
      item,
      requirements.flatMap((name) => [`--require-${name}`]),
    )
    assert.equal(result.status, 1)
    assert.match(result.stderr, /attestation-f3-state/u)
  } finally {
    rmSync(item.directory, { recursive: true, force: true })
  }
})

const mutations = [
  [
    "bounds",
    "apps/media-sidecar/src/operations.rs",
    "EXTRACTOR_PERMITS: usize = 4",
    "EXTRACTOR_PERMITS: usize = 5",
  ],
  [
    "supervised-cancellation",
    "apps/media-sidecar/src/process.rs",
    ".process_group(0)",
    ".process_group(1)",
  ],
  [
    "direct-no-redirect-http",
    "apps/server/src/media/youtube-sidecar-client.ts",
    'redirect: "manual"',
    'redirect: "follow"',
  ],
  [
    "private-observation",
    "apps/media-sidecar/src/observation.rs",
    "media_sidecar_observation.v1",
    "public_observation.v1",
  ],
  [
    "redacted-logs",
    "apps/server/src/media/youtube-sidecar-observation.ts",
    'createHmac("sha256", observationSalt)',
    'createHmac("sha256", "fixed")',
  ],
  ["pins", "apps/media-sidecar/rust-toolchain.toml", 'channel = "1.98.0"', 'channel = "stable"'],
  [
    "watchdog-cas-fencing",
    "scripts/media-sidecar-remote-rollback.sh",
    "stale-sequence",
    "sequence-ignored",
  ],
  [
    "atomic-begin-run",
    "scripts/media-sidecar-remote-rollback.sh",
    'mv -f "$temp" "$target"',
    'cp "$temp" "$target"',
  ],
  [
    "daemon-convergence",
    "scripts/media-sidecar-remote-rollback.sh",
    "lateDaemonDetected=true",
    "lateDaemonDetected=false",
  ],
]

for (const [boundary, path, before, after] of mutations) {
  test(`code-quality attestation rejects ${boundary} source mutation`, () => {
    const item = fixture()
    const sourceRoot = sourceFixture(item)
    const target = join(sourceRoot, path)
    const original = readFileSync(target, "utf8")
    const mutated = original.replace(before, after)
    assert.notEqual(mutated, original)
    writeFileSync(target, mutated)
    try {
      assert.throws(
        () => attestCodeQualityFixture(fixtureValues(item), item.sha, sourceRoot),
        new RegExp(`attestation-proof-${boundary}`, "u"),
      )
    } finally {
      rmSync(item.directory, { recursive: true, force: true })
    }
  })
}

test("code-quality attestation rejects an oversized migration module", () => {
  const item = fixture()
  const sourceRoot = sourceFixture(item)
  const path = join(sourceRoot, "scripts/media-sidecar-integration.test.mjs")
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${"void 0\n".repeat(251)}`)
  try {
    assert.throws(
      () => attestCodeQualityFixture(fixtureValues(item), item.sha, sourceRoot),
      /attestation-proof-bounds/u,
    )
  } finally {
    rmSync(item.directory, { recursive: true, force: true })
  }
})
